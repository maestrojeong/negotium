/**
 * Runtime-MCP wiring shared between core (which injects the MCP into agent
 * sessions) and @negotium/mcp (which serves the endpoint).
 *
 * The runtime process exposes one HTTP MCP endpoint; every agent turn gets a
 * per-turn signed token carrying its full execution context, so the MCP layer
 * never trusts the agent to say who it is. Ported from otium runtime-api
 * `mcp/runtime-server.ts` (transport-agnostic parts only).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { NEGOTIUM_PORT, RUNTIME_MCP_SECRET } from "#platform/config";
import { type AgentKind, isAgentKind, type PeerRuntimeBridgeContext } from "#types";

export const RUNTIME_MCP_KEY = "runtime";

export const RUNTIME_MCP_BASE_PATH = "/mcp/runtime";
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const CLAUDE_MCP_TOOL_TIMEOUT_MS = 600_000;

export interface RuntimeMcpContext {
  userId: string;
  topicId: string;
  topicTitle: string;
  queryId?: string;
  cwd: string;
  agent: AgentKind;
  model?: string;
  currentUserPrompt?: string;
  autoContinue?: boolean;
  peerBridge?: PeerRuntimeBridgeContext;
}

type RuntimeTokenPayload = {
  v: 1;
  exp: number;
  ctx: RuntimeMcpContext;
};

let runtimePort = NEGOTIUM_PORT;

/** The runtime host calls this once it knows which port it actually bound. */
export function setRuntimeMcpPort(port: number): void {
  runtimePort = port;
}

export function getRuntimeMcpPort(): number {
  return runtimePort;
}

function encodeTokenPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function decodeTokenPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as unknown;
}

function signTokenPayload(payloadPart: string): string {
  return createHmac("sha256", RUNTIME_MCP_SECRET).update(payloadPart).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function isRuntimeMcpContext(value: unknown): value is RuntimeMcpContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ctx = value as Partial<RuntimeMcpContext>;
  return (
    typeof ctx.userId === "string" &&
    typeof ctx.topicId === "string" &&
    typeof ctx.topicTitle === "string" &&
    typeof ctx.cwd === "string" &&
    typeof ctx.agent === "string" &&
    isAgentKind(ctx.agent) &&
    (ctx.queryId === undefined || typeof ctx.queryId === "string") &&
    (ctx.model === undefined || typeof ctx.model === "string") &&
    (ctx.currentUserPrompt === undefined || typeof ctx.currentUserPrompt === "string") &&
    (ctx.autoContinue === undefined || typeof ctx.autoContinue === "boolean") &&
    (ctx.peerBridge === undefined ||
      (typeof ctx.peerBridge.hubCellId === "string" &&
        typeof ctx.peerBridge.hostTopicId === "string" &&
        typeof ctx.peerBridge.hostQueryId === "string" &&
        typeof ctx.peerBridge.canSpawnSubagents === "boolean"))
  );
}

export function issueRuntimeMcpToken(ctx: RuntimeMcpContext): string {
  const payloadPart = encodeTokenPart({
    v: 1,
    exp: Date.now() + TOKEN_TTL_MS,
    ctx,
  } satisfies RuntimeTokenPayload);
  return `${payloadPart}.${signTokenPayload(payloadPart)}`;
}

export function resolveRuntimeMcpToken(token: string | null): RuntimeMcpContext | null {
  if (!token) return null;
  const [payloadPart, signature, extra] = token.split(".");
  if (!payloadPart || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, signTokenPayload(payloadPart))) return null;

  try {
    const payload = decodeTokenPart(payloadPart) as Partial<RuntimeTokenPayload>;
    if (payload.v !== 1 || typeof payload.exp !== "number" || payload.exp <= Date.now())
      return null;
    if (!isRuntimeMcpContext(payload.ctx)) return null;
    return payload.ctx;
  } catch {
    return null;
  }
}

/**
 * MCP server spec injected into an agent session's MCP config so the agent
 * connects back to this node's runtime endpoint with its per-turn token.
 */
export function buildRuntimeMcpSpec(
  agent: AgentKind,
  ctx: RuntimeMcpContext,
): Record<string, unknown> {
  const token = issueRuntimeMcpToken(ctx);
  const base = `http://127.0.0.1:${runtimePort}${RUNTIME_MCP_BASE_PATH}`;
  const query = `token=${encodeURIComponent(token)}`;
  if (agent === "codex") return { url: `${base}/mcp?${query}` };
  return {
    type: "sse" as const,
    url: `${base}/sse?${query}`,
    timeout: CLAUDE_MCP_TOOL_TIMEOUT_MS,
  };
}
