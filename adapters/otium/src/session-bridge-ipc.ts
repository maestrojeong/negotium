import { timingSafeEqual } from "node:crypto";
import type { PeerForwardArgs, PeerSessionBridge, RemoteReplyRoute } from "@negotium/core";
import { registerPeerSessionBridgeIpcConfig } from "@negotium/core/peer-session-bridge-ipc";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INFLIGHT = 32;
const BODY_TIMEOUT_MS = 10_000;

type BridgeRequest =
  | { action: "forward"; args: PeerForwardArgs }
  | { action: "sessions"; userId: string; sourceQueryId?: string }
  | {
      action: "reply";
      route: RemoteReplyRoute;
      sourceTitle: string;
      replyText: string;
      kind: "reply" | "error";
    };

function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function boundedString(value: unknown, max = 16_384): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validRequest(payload: BridgeRequest): boolean {
  if (!payload || typeof payload !== "object" || !boundedString(payload.action, 16)) return false;
  if (payload.action === "sessions") return boundedString(payload.userId, 512);
  if (payload.action === "forward") {
    const args = payload.args;
    return (
      Boolean(args) &&
      ["tell", "ask", "abort"].includes(args.action) &&
      boundedString(args.toNode, 512) &&
      boundedString(args.toTopic, 512) &&
      boundedString(args.userId, 512) &&
      (args.message === undefined || boundedString(args.message, 256 * 1024))
    );
  }
  if (payload.action === "reply") {
    return (
      Boolean(payload.route) &&
      boundedString(payload.route.userId, 512) &&
      boundedString(payload.route.requestId, 512) &&
      boundedString(payload.sourceTitle, 2048) &&
      boundedString(payload.replyText, 256 * 1024) &&
      ["reply", "error"].includes(payload.kind)
    );
  }
  return false;
}

async function readLimitedJson(request: Request): Promise<BridgeRequest | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timeout = setTimeout(
    () => void reader.cancel("peer bridge request body timeout").catch(() => undefined),
    BODY_TIMEOUT_MS,
  );
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeRequest;
  } catch {
    return null;
  }
}

export interface PeerSessionBridgeIpcHandle {
  url: string;
  stop(): void;
}

/** Expose the worker bridge to inherited MCP subprocesses over authenticated loopback IPC. */
export function startPeerSessionBridgeIpc(bridge: PeerSessionBridge): PeerSessionBridgeIpcHandle {
  const token = crypto.randomUUID() + crypto.randomUUID();
  let inflight = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!authorized(request, token)) return new Response("unauthorized", { status: 401 });
      if (inflight >= MAX_INFLIGHT) return new Response("busy", { status: 503 });
      inflight += 1;
      try {
        const payload = await readLimitedJson(request);
        if (!payload || !validRequest(payload)) {
          return new Response("invalid request", { status: 400 });
        }
        if (payload.action === "forward") {
          return Response.json(await bridge.forward(payload.args));
        }
        if (payload.action === "sessions") {
          return Response.json(await bridge.sessions(payload.userId, payload.sourceQueryId));
        }
        if (payload.action === "reply") {
          return Response.json(
            await bridge.reply(payload.route, payload.sourceTitle, payload.replyText, payload.kind),
          );
        }
        return new Response("invalid action", { status: 400 });
      } catch {
        return new Response("bridge failed", { status: 502 });
      } finally {
        inflight -= 1;
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  const unregisterConfig = registerPeerSessionBridgeIpcConfig({ url, token });
  let stopped = false;

  return {
    url,
    stop() {
      if (stopped) return;
      stopped = true;
      unregisterConfig();
      server.stop(true);
    },
  };
}
