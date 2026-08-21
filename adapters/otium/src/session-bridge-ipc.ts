import { timingSafeEqual } from "node:crypto";
import type { PeerForwardArgs, PeerSessionBridge, RemoteReplyRoute } from "@negotium/core";
import { registerPeerSessionBridgeIpcConfig } from "@negotium/core/peer-session-bridge-ipc";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INFLIGHT = 32;
const MAX_QUEUE_DEPTH = MAX_INFLIGHT * 4;
const BODY_TIMEOUT_MS = 10_000;

type BridgeRequest =
  | { action: "forward"; args: PeerForwardArgs }
  | { action: "sessions"; userId: string; sourceQueryId?: string; fromTopicId?: string }
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

async function readLimitedJson(request: Request, deadline: number): Promise<BridgeRequest | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("peer bridge request body timeout")),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
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

export interface PeerSessionBridgeIpcOptions {
  /** Test seam; production uses the fixed defaults above. */
  maxInflight?: number;
  /** Test seam; production uses the fixed defaults above. */
  maxQueueDepth?: number;
  /** Shared queue and body-read budget; production uses BODY_TIMEOUT_MS. */
  requestTimeoutMs?: number;
}

/** Expose the worker bridge to inherited MCP subprocesses over authenticated loopback IPC. */
export function startPeerSessionBridgeIpc(
  bridge: PeerSessionBridge,
  options: PeerSessionBridgeIpcOptions = {},
): PeerSessionBridgeIpcHandle {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const maxInflight = options.maxInflight ?? MAX_INFLIGHT;
  const maxQueueDepth = options.maxQueueDepth ?? MAX_QUEUE_DEPTH;
  const requestTimeoutMs = options.requestTimeoutMs ?? BODY_TIMEOUT_MS;
  let inflight = 0;
  type QueueWaiter = {
    resolve: (admitted: boolean) => void;
    timeout: ReturnType<typeof setTimeout>;
  };
  const queue: QueueWaiter[] = [];

  function release(): void {
    inflight -= 1;
    const waiter = queue.shift();
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    inflight += 1;
    waiter.resolve(true);
  }

  function acquire(waitTimeoutMs: number): Promise<boolean> | boolean {
    if (inflight < maxInflight) {
      inflight += 1;
      return true;
    }
    if (waitTimeoutMs <= 0 || queue.length >= maxQueueDepth) return false;
    return new Promise<boolean>((resolve) => {
      const waiter = {
        resolve,
        timeout: setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          resolve(false);
        }, waitTimeoutMs),
      };
      queue.push(waiter);
    });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!authorized(request, token)) return new Response("unauthorized", { status: 401 });
      const deadline = Date.now() + requestTimeoutMs;
      const admitted = await acquire(deadline - Date.now());
      if (!admitted) {
        return new Response("busy", { status: 503, headers: { "retry-after": "1" } });
      }
      try {
        const payload = await readLimitedJson(request, deadline);
        if (!payload || !validRequest(payload)) {
          return new Response("invalid request", { status: 400 });
        }
        if (payload.action === "forward") {
          return Response.json(await bridge.forward(payload.args));
        }
        if (payload.action === "sessions") {
          return Response.json(
            await bridge.sessions(payload.userId, payload.sourceQueryId, payload.fromTopicId),
          );
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
        release();
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
