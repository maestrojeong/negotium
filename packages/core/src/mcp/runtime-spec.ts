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
import { isExplicitAgentSwitchTargets } from "#agents/explicit-agent-switch";
import { NEGOTIUM_PORT, RUNTIME_MCP_SECRET } from "#platform/config";
import { logger } from "#platform/logger";
import { isActorTopicScope } from "#runtime/actor-topic-scope";
import { isRemoteSessionGrant } from "#runtime/remote-session-grant";
import {
  type ActorTopicScope,
  type AgentKind,
  isAgentKind,
  type PeerRuntimeBridgeContext,
  type RemoteSessionGrant,
} from "#types";

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

/**
 * Hard ceiling on the length of a built-in MCP URL (path plus `?token=...`).
 *
 * The signed per-turn token rides the URL query of an `http://127.0.0.1`
 * request, and `Bun.serve` answers 431 once the request line is too long:
 * measured on Bun 1.3.14 with a plain `fetch`, a 16,205-character URL is
 * served (200) and a 16,305-character one is refused (431). The budget stays
 * 1,869 characters under the last known-good length so the server, the
 * agent's own client and a slightly different Bun release all have room.
 *
 * Real sizes (UUID ids, base64url growth of 4/3 on the JSON payload):
 * - runtime token, no assertion, every optional field set (peer bridge,
 *   thread, 64-char title, workspace cwd, all three explicit-switch
 *   targets): ~1,150-character URL;
 * - the same with the largest assertion `validateActorTopicScope` admits
 *   (8,159 bytes of JSON = 208 UUIDs): 12,052–12,055 characters, under this
 *   budget with ~2,280 characters to spare for an unusually long cwd or title;
 *   the hosted tokens (`buildHostedMcpSpec`) with the same assertion measure
 *   12,100–12,118, so neither variant is the "small" one.
 * The token has no free-text field: the user's prompt never rides it. It used
 * to, and an uncapped prompt made the assertion cap meaningless (3,000 Korean
 * characters on top of the maximal assertion gave a 24,009-character URL and
 * 10,000 gave 52,009 — every built-in MCP unreachable for that turn), while a
 * capped one broke `set_agent` for any request phrased after the cap. The
 * prompt's only consumer was that gate, so the node now derives the gate's
 * answer from the full prompt when it mints the token
 * (`explicitAgentSwitchTargets`, at most three agent names) and signs that.
 *
 * Over budget, {@link buildRuntimeMcpSpec} throws
 * {@link McpUrlBudgetExceededError} rather than minting a URL that will 431.
 * Nothing is dropped or trimmed to fit: every remaining field either
 * authorizes (ids, assertion, switch targets) or changes behaviour (thread,
 * capabilities, bridge), and a token missing one would widen or alter the
 * turn, not narrow it.
 */
export const MCP_URL_BUDGET_CHARS = 14 * 1024;

export class McpUrlBudgetExceededError extends Error {
  constructor(
    readonly surface: string,
    readonly urlLength: number,
  ) {
    super(
      `built-in MCP URL for "${surface}" is ${urlLength} characters; the transport allows at most ${MCP_URL_BUDGET_CHARS}`,
    );
    this.name = "McpUrlBudgetExceededError";
  }
}

export interface RuntimeMcpContext {
  /** Canonical principal authorized against this node's topic roster. */
  userId: string;
  /** Product-side human actor when it differs from the execution principal. */
  actorUserId?: string;
  /**
   * Hub-asserted rooms `actorUserId` may reach on this node. Signed with the
   * rest of the context and authoritative when present (no lineage is added);
   * absent means the tools reach only the current room plus its own subagent
   * lineage.
   */
  actorTopicScope?: ActorTopicScope;
  topicId: string;
  topicTitle: string;
  queryId?: string;
  cwd: string;
  agent: AgentKind;
  model?: string;
  /**
   * Agents the current user message explicitly asked to switch to, derived
   * from the full prompt at mint time (`explicitAgentSwitchTargets`). Signed
   * with the rest of the context, so the agent cannot grant itself a switch;
   * absent or empty means `set_agent` is refused this turn.
   */
  explicitAgentSwitchTargets?: AgentKind[];
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
  /** Product-side human actor when it differs from the execution principal. */
  actorUserId?: string;
  /** Hub-asserted rooms `actorUserId` may reach; see {@link RuntimeMcpContext}. */
  actorTopicScope?: ActorTopicScope;
  /**
   * Hub-issued per-turn authority for remote (`node/topic`) session-comm.
   * Carried by the `session-comm` audience only. Signed with the rest of the
   * context so the agent cannot mint or swap one; the capability inside is a
   * bearer for the hub, which the node cannot verify (it holds no key) and
   * only ever decodes for the untrusted `e` expiry it uses to order grants
   * when several requests fold into one turn.
   */
  remoteSession?: RemoteSessionGrant;
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
  /**
   * Thread the calling turn is answering inside.
   *
   * Present on the hosted surface as well as the stdio one: `session-comm` is
   * served both ways, and the hosted path — the default — carries its context
   * in a signed per-turn token rather than in argv.
   */
  threadRootId?: string;
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
    (ctx.actorUserId === undefined || typeof ctx.actorUserId === "string") &&
    (ctx.actorTopicScope === undefined || isActorTopicScope(ctx.actorTopicScope)) &&
    (ctx.queryId === undefined || typeof ctx.queryId === "string") &&
    (ctx.model === undefined || typeof ctx.model === "string") &&
    (ctx.explicitAgentSwitchTargets === undefined ||
      isExplicitAgentSwitchTargets(ctx.explicitAgentSwitchTargets)) &&
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
    (ctx.actorUserId === undefined || typeof ctx.actorUserId === "string") &&
    (ctx.actorTopicScope === undefined || isActorTopicScope(ctx.actorTopicScope)) &&
    (ctx.remoteSession === undefined || isRemoteSessionGrant(ctx.remoteSession)) &&
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
  const base = `http://127.0.0.1:${runtimePort}${RUNTIME_MCP_BASE_PATH}`;
  const query = `token=${encodeURIComponent(issueRuntimeMcpToken(ctx))}`;
  const url = agent === "codex" ? `${base}/mcp?${query}` : `${base}/sse?${query}`;
  assertMcpUrlWithinBudget(RUNTIME_MCP_KEY, url, ctx.topicId);
  if (agent === "codex") return { url };
  return {
    type: "sse" as const,
    url,
    timeout: CLAUDE_MCP_TOOL_TIMEOUT_MS,
    ...(agent === "maestro" ? { lifecycle: "turn" as const } : {}),
  };
}

/**
 * Refuse loudly rather than hand the agent a URL the server will 431. This
 * fails the turn's MCP setup, which is the safe outcome: the alternative —
 * minting the token without the fields that do not fit — would silently
 * widen the turn whenever the field that did not fit was the assertion.
 */
function assertMcpUrlWithinBudget(surface: string, url: string, topicId: string | undefined) {
  if (url.length <= MCP_URL_BUDGET_CHARS) return;
  const error = new McpUrlBudgetExceededError(surface, url.length);
  logger.error(
    { topicId, surface, urlLength: url.length, budget: MCP_URL_BUDGET_CHARS },
    "built-in MCP URL exceeds the transport budget; refusing to mint the token",
  );
  throw error;
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
        // Who may reach what changes per turn (a different person, or a hub
        // that has since changed a roster), so a cached server must not carry
        // an earlier turn's reach into this one.
        actorUserId: ctx.actorUserId ?? null,
        actorTopicScope: ctx.actorTopicScope ?? null,
        // The grant is per turn (bound to this turn's request id), so a
        // server cached with one must not answer a later turn with it.
        remoteSession: ctx.remoteSession ?? null,
        topicTitle: ctx.topicTitle,
        topicId: ctx.topicId ?? null,
        subagentParentTopicId: ctx.subagentParentTopicId ?? null,
        depth: ctx.depth ?? 0,
        silent: ctx.silent ?? false,
        agent: ctx.agent,
        // Part of the identity, not a detail: a server cached for a channel
        // turn would otherwise be reused for a thread turn and record the ask
        // against the wrong conversation.
        threadRootId: ctx.threadRootId ?? null,
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
  const url = agent === "codex" ? `${base}/mcp?${query}` : `${base}/sse?${query}`;
  // A hosted context has no free-text field either. Measured with the
  // maximal assertion (208 UUIDs, 8,159 bytes) and every optional field set,
  // the hosted URL is marginally *longer* than the runtime one — ~12,118
  // characters for `session-comm`, 12,100–12,109 for the other surfaces,
  // against 12,052–12,055 for the runtime token — because the surface name
  // and lifecycle fields outweigh the runtime token's switch-target list.
  // All stay ≥ 2,200 characters under budget. The session-comm token may
  // additionally carry a remote-session grant. Measured in
  // `hosted-runtime-spec.test.ts`: the hub's real grant (≈440-character
  // capability, short hub URL) adds 682 characters — 12,800 beside the
  // maximal assertion, ~1,500 to spare. A grant at both caps (512-char URL,
  // 2 KiB capability) adds ≈3,475 and fits alone (4,689) but not beside the
  // maximal assertion (15,593); the hard check below refuses that mint, so
  // the caps bound the grant while the budget bounds the token — the largest
  // capability that fits beside a maximal assertion is ≈1,590 characters.
  // The check is the same on purpose, so a field added later cannot quietly
  // push it past the transport.
  assertMcpUrlWithinBudget(surface, url, ctx.topicId);
  if (agent === "codex") return { url };
  const queryBound =
    surface === "session-comm" &&
    (ctx.silent === true || ctx.peerBridge !== undefined || ctx.remoteSession !== undefined);
  const lifecycle = queryBound ? "turn" : surface === "session-comm" ? "session" : "process";
  return {
    type: "sse" as const,
    url,
    timeout: CLAUDE_MCP_TOOL_TIMEOUT_MS,
    ...(agent === "maestro"
      ? {
          lifecycle,
          cacheKey: hostedMcpCacheIdentity(surface, ctx),
        }
      : {}),
  };
}
