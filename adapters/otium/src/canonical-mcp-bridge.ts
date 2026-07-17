import { randomUUID } from "node:crypto";
import type {
  CanonicalMcpBridgeScope,
  CanonicalMcpSurface,
} from "@negotium/core/canonical-mcp-bridge";
import { registerCanonicalMcpBridgeEnvProvider } from "@negotium/core/canonical-mcp-bridge";
import { mintPeerToken, resolvePeerNodeByCellId } from "@/central";
import { PEER_PROTOCOL_VERSION } from "@/protocol";

const MAX_BODY_BYTES = 1024 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;
const MAX_INFLIGHT = 32;
const CAPABILITY_TTL_MS = 60 * 60 * 1000;
const MAX_CAPABILITIES = 2048;
const FORWARD_TIMEOUT_MS = 25_000;

const TOOL_ALLOWLIST: Record<CanonicalMcpSurface, ReadonlySet<string>> = {
  task: new Set(["task_create", "task_update", "task_list", "task_get", "task_delete"]),
  wiki: new Set([
    "wiki_query",
    "wiki_topic_brief",
    "wiki_last_conversation",
    "save_wiki_entry",
    "index_upsert",
  ]),
};

type Capability = {
  surface: CanonicalMcpSurface;
  userId: string;
  hostTopicId: string;
  hostQueryId: string;
  hubCellId: string;
  expiresAt: number;
};

type BridgeRequest = { tool: string; input: Record<string, unknown> };
type CanonicalToolResult = {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
};

function readAuthorization(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

async function readLimitedJson(request: Request): Promise<BridgeRequest | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + BODY_READ_TIMEOUT_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("body read timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("body read timeout")), remaining);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("body too large");
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    if (typeof body.tool !== "string" || body.tool.length > 128) return null;
    if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) return null;
    return { tool: body.tool, input: body.input as Record<string, unknown> };
  } catch {
    return null;
  }
}

async function forwardCanonicalTool(
  capability: Capability,
  request: BridgeRequest,
): Promise<{ result?: CanonicalToolResult; error?: string; status?: number }> {
  if (!TOOL_ALLOWLIST[capability.surface].has(request.tool)) {
    return { error: `tool is not available on ${capability.surface}`, status: 403 };
  }
  const hub = await resolvePeerNodeByCellId(capability.hubCellId).catch(() => null);
  if (!hub?.isPrimary || hub.self) return { error: "canonical hub is unavailable", status: 503 };
  try {
    const peerToken = await mintPeerToken(hub.cellId);
    const response = await fetch(
      `${hub.baseUrl.replace(/\/+$/, "")}/api/v1/peer/bridge/canonical-mcp`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${peerToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          v: PEER_PROTOCOL_VERSION,
          surface: capability.surface,
          userId: capability.userId,
          hostTopicId: capability.hostTopicId,
          hostQueryId: capability.hostQueryId,
          tool: request.tool,
          input: request.input,
        }),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: CanonicalToolResult;
      error?: string;
    } | null;
    if (!response.ok || !body?.ok || !body.result) {
      return {
        error: body?.error ?? `canonical hub failed (${response.status})`,
        status: response.status,
      };
    }
    return { result: body.result };
  } catch (cause) {
    return { error: (cause as Error).message || "canonical hub unreachable", status: 502 };
  }
}

export interface CanonicalMcpBridgeHandle {
  url: string;
  stop(): void;
}

export interface CanonicalMcpBridgeOptions {
  /** Test seam; production always forwards to the authenticated Otium hub. */
  forwardTool?: typeof forwardCanonicalTool;
}

/**
 * Give only placed-turn MCP subprocesses a short-lived, turn-scoped route to
 * canonical hub task/wiki state. Vault, skills, and browser/provider profiles
 * never enter this bridge and continue to resolve on the worker node.
 */
export function startCanonicalMcpBridge(
  options: CanonicalMcpBridgeOptions = {},
): CanonicalMcpBridgeHandle {
  const capabilities = new Map<string, Capability>();
  let inflight = 0;

  function sweep(now = Date.now()): void {
    for (const [token, capability] of capabilities) {
      if (capability.expiresAt <= now) capabilities.delete(token);
    }
    while (capabilities.size >= MAX_CAPABILITIES) {
      const oldest = capabilities.keys().next().value as string | undefined;
      if (!oldest) break;
      capabilities.delete(oldest);
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const token = readAuthorization(request);
      if (!token) return new Response("unauthorized", { status: 401 });
      const capability = capabilities.get(token);
      if (!capability || capability.expiresAt <= Date.now()) {
        capabilities.delete(token);
        return new Response("unauthorized", { status: 401 });
      }
      if (inflight >= MAX_INFLIGHT) return new Response("busy", { status: 503 });
      inflight += 1;
      try {
        const payload = await readLimitedJson(request);
        if (!payload) return new Response("invalid request", { status: 400 });
        if (!TOOL_ALLOWLIST[capability.surface].has(payload.tool)) {
          return new Response("tool denied", { status: 403 });
        }
        const result = await (options.forwardTool ?? forwardCanonicalTool)(capability, payload);
        return Response.json(result, { status: result.status ?? (result.result ? 200 : 502) });
      } finally {
        inflight -= 1;
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  const unregister = registerCanonicalMcpBridgeEnvProvider((scope: CanonicalMcpBridgeScope) => {
    sweep();
    const token = `${randomUUID()}${randomUUID()}`;
    capabilities.set(token, {
      surface: scope.surface,
      userId: scope.userId,
      hostTopicId: scope.peerBridge.hostTopicId,
      hostQueryId: scope.peerBridge.hostQueryId,
      hubCellId: scope.peerBridge.hubCellId,
      expiresAt: Date.now() + CAPABILITY_TTL_MS,
    });
    return {
      NEGOTIUM_CANONICAL_MCP_BRIDGE_URL: url,
      NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN: token,
    };
  });
  let stopped = false;
  return {
    url,
    stop() {
      if (stopped) return;
      stopped = true;
      unregister();
      capabilities.clear();
      server.stop(true);
    },
  };
}
