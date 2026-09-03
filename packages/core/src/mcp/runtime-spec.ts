/**
 * Runtime-MCP wiring shared between core (which injects the MCP into agent
 * sessions) and @negotium/mcp (which serves the endpoint).
 *
 * The runtime process exposes one HTTP MCP endpoint; every agent turn gets a
 * per-turn signed token carrying its full execution context, so the MCP layer
 * never trusts the agent to say who it is. Ported from otium runtime-api
 * `mcp/runtime-server.ts` (transport-agnostic parts only).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NEGOTIUM_PORT, RUNTIME_MCP_SECRET } from "#platform/config";
import { type AgentKind, isAgentKind, type PeerRuntimeBridgeContext } from "#types";

export const RUNTIME_MCP_KEY = "runtime";

export const RUNTIME_MCP_BASE_PATH = "/mcp/runtime";
export const HOSTED_MCP_SURFACES = [
  "task",
  "decision",
  "token-stats",
  "system-health",
  "vault",
  "wiki",
  "skills",
  "session-comm",
  "agent-health",
] as const;
export type HostedMcpSurface = (typeof HOSTED_MCP_SURFACES)[number];
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
  /** Capability minted by the adapter. Visual tools are absent unless true. */
  visualTools?: boolean;
  /** Capability minted by the adapter. File-delivery tools are absent unless true. */
  fileDeliveryTools?: boolean;
  /**
   * Thread this turn is answering inside, when it is answering in one.
   *
   * The runtime MCP is built per turn from a signed token, so unlike the
   * session — which spans the whole topic — this context can carry a value
   * that changes from one turn to the next. That is what lets `thread_read`
   * default to "the thread I am in" with no argument.
   */
  threadRootId?: string;
  peerBridge?: PeerRuntimeBridgeContext;
}

/** Signed identity/capability context shared by hosted built-in MCP surfaces. */
export interface HostedMcpContext {
  userId: string;
  topicTitle: string;
  topicId?: string;
  queryId?: string;
  wikiTopicId?: string;
  subagentParentTopicId?: string;
  cwd: string;
  agent: AgentKind;
  model?: string;
  depth?: number;
  silent?: boolean;
  peerBridge?: PeerRuntimeBridgeContext;
}

type RuntimeTokenPayload = {
  v: 1;
  exp: number;
  ctx: RuntimeMcpContext;
};

type HostedTokenPayload = {
  v: 2;
  exp: number;
  aud: HostedMcpSurface;
  ctx: HostedMcpContext;
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
    (ctx.visualTools === undefined || typeof ctx.visualTools === "boolean") &&
    (ctx.fileDeliveryTools === undefined || typeof ctx.fileDeliveryTools === "boolean") &&
    (ctx.peerBridge === undefined ||
      (typeof ctx.peerBridge.hubCellId === "string" &&
        typeof ctx.peerBridge.hostTopicId === "string" &&
        typeof ctx.peerBridge.hostQueryId === "string" &&
        typeof ctx.peerBridge.canSpawnSubagents === "boolean"))
  );
}

export function isHostedMcpSurface(value: string): value is HostedMcpSurface {
  return (HOSTED_MCP_SURFACES as readonly string[]).includes(value);
}

function isHostedMcpContext(value: unknown): value is HostedMcpContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ctx = value as Partial<HostedMcpContext>;
  return (
    typeof ctx.userId === "string" &&
    typeof ctx.topicTitle === "string" &&
    typeof ctx.cwd === "string" &&
    typeof ctx.agent === "string" &&
    isAgentKind(ctx.agent) &&
    (ctx.topicId === undefined || typeof ctx.topicId === "string") &&
    (ctx.queryId === undefined || typeof ctx.queryId === "string") &&
    (ctx.wikiTopicId === undefined || typeof ctx.wikiTopicId === "string") &&
    (ctx.subagentParentTopicId === undefined || typeof ctx.subagentParentTopicId === "string") &&
    (ctx.model === undefined || typeof ctx.model === "string") &&
    (ctx.depth === undefined || (Number.isInteger(ctx.depth) && ctx.depth >= 0)) &&
    (ctx.silent === undefined || typeof ctx.silent === "boolean") &&
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

export function issueHostedMcpToken(surface: HostedMcpSurface, ctx: HostedMcpContext): string {
  const payloadPart = encodeTokenPart({
    v: 2,
    exp: Date.now() + TOKEN_TTL_MS,
    aud: surface,
    ctx,
  } satisfies HostedTokenPayload);
  return `${payloadPart}.${signTokenPayload(payloadPart)}`;
}

export function resolveHostedMcpToken(
  token: string | null,
  surface: HostedMcpSurface,
): HostedMcpContext | null {
  if (!token) return null;
  const [payloadPart, signature, extra] = token.split(".");
  if (!payloadPart || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, signTokenPayload(payloadPart))) return null;

  try {
    const payload = decodeTokenPart(payloadPart) as Partial<HostedTokenPayload>;
    if (
      payload.v !== 2 ||
      payload.aud !== surface ||
      typeof payload.exp !== "number" ||
      payload.exp <= Date.now()
    ) {
      return null;
    }
    return isHostedMcpContext(payload.ctx) ? payload.ctx : null;
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
    ...(agent === "maestro" ? { lifecycle: "turn" as const } : {}),
  };
}

function hostedMcpCacheIdentity(surface: HostedMcpSurface, ctx: HostedMcpContext): string {
  let semanticContext: unknown;
  switch (surface) {
    case "system-health":
      semanticContext = {};
      break;
    case "token-stats":
    case "agent-health":
      semanticContext = { userId: ctx.userId };
      break;
    case "task":
      semanticContext = {
        userId: ctx.userId,
        topicTitle: ctx.topicTitle,
        topicId: ctx.topicId ?? null,
      };
      break;
    case "wiki":
    case "skills":
      semanticContext = {
        userId: ctx.userId,
        topicId: ctx.wikiTopicId ?? ctx.topicId ?? null,
      };
      break;
    case "vault":
      semanticContext = { userId: ctx.userId, cwd: ctx.cwd, agent: ctx.agent };
      break;
    case "session-comm":
      semanticContext = {
        userId: ctx.userId,
        topicTitle: ctx.topicTitle,
        topicId: ctx.topicId ?? null,
        subagentParentTopicId: ctx.subagentParentTopicId ?? null,
        depth: ctx.depth ?? 0,
        silent: ctx.silent ?? false,
        agent: ctx.agent,
        peerBridge: ctx.peerBridge ?? null,
      };
      break;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify([surface, semanticContext]))
    .digest("hex")
    .slice(0, 24);
  return `hosted:${surface}:${digest}`;
}

/** Build an agent transport spec for one logical MCP surface on the shared runtime process. */
export function buildHostedMcpSpec(
  agent: AgentKind,
  surface: HostedMcpSurface,
  ctx: HostedMcpContext,
): Record<string, unknown> {
  const token = issueHostedMcpToken(surface, ctx);
  const base = `http://127.0.0.1:${runtimePort}${RUNTIME_MCP_BASE_PATH}/${surface}`;
  const query = `token=${encodeURIComponent(token)}`;
  if (agent === "codex") return { url: `${base}/mcp?${query}` };
  const queryBound =
    surface === "session-comm" && (ctx.silent === true || ctx.peerBridge !== undefined);
  const lifecycle = queryBound ? "turn" : surface === "session-comm" ? "session" : "process";
  return {
    type: "sse" as const,
    url: `${base}/sse?${query}`,
    timeout: CLAUDE_MCP_TOOL_TIMEOUT_MS,
    ...(agent === "maestro"
      ? {
          lifecycle,
          cacheKey: hostedMcpCacheIdentity(surface, ctx),
        }
      : {}),
  };
}
