import { createHmac } from "node:crypto";
import { canonicalMcpBridgeEnv } from "#mcp/canonical-bridge-config";
import { buildRuntimeMcpSpec, RUNTIME_MCP_KEY } from "#mcp/runtime-spec";
import { peerSessionBridgeIpcEnv } from "#mcp/session-comm/bridge-ipc-config";
import {
  AGENT_HEALTH_SERVER,
  CANONICAL_MCP_PROXY_SERVER,
  FALLBACK_AGENT,
  PADDLEOCR_SERVER,
  resolveTopicWorkspaceDir,
  SESSION_COMM_SERVER,
  SYSTEM_HEALTH_SERVER,
  TASK_SERVER,
  TOKEN_STATS_SERVER,
  TSCONFIG_PATH,
  TSX_BIN,
  VAULT_SERVER,
  WIKI_SERVER,
} from "#platform/config";
import { logger } from "#platform/logger";
import type { AgentKind, AgentQueryOptions, PeerRuntimeBridgeContext } from "#types";

/**
 * Build the stdio transport spec for a Otium MCP server entry.
 *
 * claude/maestro launch the .ts server directly with `bun run` (fast, native
 * TypeScript + bun:sqlite). codex CANNOT — codex 0.135's rmcp stdio client
 * fails to handshake with bun-spawned servers (initialize is dropped/raced, so
 * no tools reach the model), while pure-node servers connect reliably. So for
 * the `codex` agent we launch the SAME server file via node + tsx, passing the
 * tsconfig explicitly (servers run with cwd ≠ PROJECT_ROOT, so tsx can't find
 * it on its own) so `@/*` path aliases resolve. Per-turn agent-aware config
 * means switching agents mid-topic just works: each turn re-spawns with the
 * right runtime.
 */
export function buildStdioMcpServer(
  agent: AgentKind | undefined,
  serverFile: string,
  serverArgs: string[],
  env?: Record<string, string>,
): Record<string, unknown> {
  if (agent === "codex") {
    return {
      command: "node",
      args: [TSX_BIN, serverFile, ...serverArgs],
      // Merged onto codex's inherited env (not a replacement) — verified.
      env: { TSX_TSCONFIG_PATH: TSCONFIG_PATH, ...env },
    };
  }
  return {
    command: "bun",
    args: ["run", serverFile, ...serverArgs],
    ...(env ? { env } : {}),
  };
}

// --- Playwright unavailable notifier + per-turn state ---
//
// When the playwright manager fails to allocate a long-lived MCP port,
// the catalog used to fall back to a per-turn stdio chromium that ran as
// a child of the agent CLI subprocess — which meant Chromium was bound
// to the agent's process tree and died on cascade-kill. We now skip the
// browser entry entirely (the playwright entry is omitted from the
// catalog for that turn) AND surface the gap two ways:
//
//   1. `notifyPlaywrightUnavailable` — fire-and-forget callback for the host
//      (telegram bot) to push an alert to the current topic. Throttled
//      per (userId, topic) with a 5-minute cooldown so a flaky
//      manager doesn't spam the chat. Per-process state — restart clears.
//
//   2. `consumePlaywrightUnavailable` — the system-prompt builder reads
//      this flag to add an explicit "Playwright unavailable this turn"
//      reminder to the agent's user message, so the model knows to
//      route around browser tools instead of hallucinating a call to a
//      tool that was silently removed from the schema list.

type PlaywrightUnavailableContext = {
  userId: string;
  topic: string | undefined;
  agent: AgentKind | undefined;
};

type PlaywrightUnavailableNotifier = (ctx: PlaywrightUnavailableContext) => void;

let _playwrightUnavailableNotifier: PlaywrightUnavailableNotifier | undefined;
const _playwrightUnavailableLastNotifiedAt = new Map<string, number>();
const _PLAYWRIGHT_UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;

const _playwrightUnavailableThisTurn = new Set<string>();

function _playwrightUnavailableKey(userId: string, topic: string | undefined): string {
  return `${userId}:${topic ?? ""}`;
}

/**
 * Register the host's "playwright unavailable" alert sink. Called once at bot
 * startup. Idempotent — last writer wins.
 */
export function setPlaywrightUnavailableNotifier(cb: PlaywrightUnavailableNotifier): void {
  _playwrightUnavailableNotifier = cb;
}

/**
 * Mark the current turn as missing long-lived Playwright and notify the host.
 * The playwright catalog entry calls this when it is built without a port, but
 * route-level callers can call it earlier after ensurePlaywright fails so the
 * system prompt for the same turn can include the unavailable reminder.
 */
export function markPlaywrightUnavailable(ctx: PlaywrightUnavailableContext): void {
  _markPlaywrightUnavailable(ctx);
}

function _markPlaywrightUnavailable(ctx: PlaywrightUnavailableContext): void {
  // Mark unavailable for the next system-prompt build, regardless of
  // notifier presence (the model-side reminder must always fire so the
  // agent doesn't try to call a missing tool).
  _playwrightUnavailableThisTurn.add(_playwrightUnavailableKey(ctx.userId, ctx.topic));

  if (!_playwrightUnavailableNotifier) return;
  const key = _playwrightUnavailableKey(ctx.userId, ctx.topic);
  const now = Date.now();
  const last = _playwrightUnavailableLastNotifiedAt.get(key) ?? 0;
  if (now - last < _PLAYWRIGHT_UNAVAILABLE_COOLDOWN_MS) return;
  _playwrightUnavailableLastNotifiedAt.set(key, now);
  try {
    _playwrightUnavailableNotifier(ctx);
  } catch (err) {
    logger.warn({ err }, "playwright unavailable notifier threw");
  }
}

/**
 * Read + clear the "playwright unavailable this turn" flag for a
 * (user, group, topic). Used by the system-prompt builder right before
 * the agent query starts. Single consumer pattern — calling more than
 * once per turn returns `false` for the second caller (intended; the
 * reminder only needs to ride one prompt).
 */
export function consumePlaywrightUnavailable(userId: string, topic: string | undefined): boolean {
  const key = _playwrightUnavailableKey(userId, topic);
  if (!_playwrightUnavailableThisTurn.has(key)) return false;
  _playwrightUnavailableThisTurn.delete(key);
  return true;
}

/**
 * Single source of truth for MCP server registration.
 *
 * Each entry declares which scopes it participates in (`dm`, `forum`, `fork`, `cron`)
 * and how to build its spawn config given a context. Public helpers
 * (`getDmMcpServers`, `getForumMcpServers`, `getForkMcpServers`) and the
 * derived `ALL_FORUM_MCP_SERVER_NAMES` / `REQUIRED_FORUM_MCP_SERVERS`
 * constants all read from this catalog, so adding a new MCP server is a
 * one-line append here instead of touching three places.
 *
 * Conventions:
 *   - `scopes` lists every scope the server should appear in by default.
 *   - `forumRequired: true` keeps the server even when a forum topic
 *     restricts the enabled list via `configure_mcp` (forum scope only).
 *   - `build(ctx)` returns the raw transport config (Claude-SDK shape).
 *     Codex callers funnel through `toCodexMcpServers` separately.
 *
 * Insertion order is preserved by `Object.entries`, which determines the
 * order of server names in user-facing displays.
 */

export type RuntimeMcpScope = "dm" | "forum" | "fork" | "manager" | "cron";

export interface RuntimeMcpBuildContext {
  userId: string;
  /** "dm" for DM scope, topic/session name for forum/fork. */
  session: string;
  /** REST/WS topic id when known. Prefer for authorization/scope checks. */
  topicId?: string;
  /** REST/WS query id when known. */
  queryId?: string;
  /** Topic id whose wiki memory should be read/written. */
  wikiTopicId?: string;
  agent?: AgentKind;
  cwd?: string;
  model?: string;
  currentUserPrompt?: string;
  depth?: number;
  playwrightPort?: number;
  playwrightCapability?: string;
  bgBashPort?: number;
  autoContinue?: boolean;
  visualTools?: boolean;
  silent?: boolean;
  peerBridge?: PeerRuntimeBridgeContext;
}

export interface RuntimeMcpCatalogEntry {
  scopes: readonly RuntimeMcpScope[];
  /** Forum scope only: cannot be removed via the enabled whitelist. */
  forumRequired?: boolean;
  /**
   * Returns the raw transport spec (Claude-SDK shape), or `null` to
   * signal "this server is unavailable for this turn — omit it from the
   * catalog entirely." Used by the playwright entry when the manager
   * cannot provide a long-lived port.
   */
  build(ctx: RuntimeMcpBuildContext): Record<string, unknown> | null;
}

// --- Playwright transport builders ---

export const CODEX_BROWSER_CAPABILITY_ENV = "NEGOTIUM_BROWSER_CAPABILITY";

export function browserOwnerCapability(capability: string, owner: string): string {
  return createHmac("sha256", capability).update(owner).digest("hex");
}

export function browserOwnerForContext(ctx: {
  userId?: string;
  session?: string;
  topicId?: string;
}): string | undefined {
  if (ctx.topicId) return `topic:${ctx.topicId}`;
  if (ctx.userId && ctx.session) return `user:${ctx.userId}:${ctx.session}`;
  return undefined;
}

function playwrightTransport(port: number, owner: string, capability: string, agent?: AgentKind) {
  const ownerCapability = browserOwnerCapability(capability, owner);
  if (agent === "codex") {
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      http_headers: { "X-Browser-Owner": owner },
      env_http_headers: { "X-Browser-Capability": CODEX_BROWSER_CAPABILITY_ENV },
    };
  }
  if (agent === "maestro") {
    const query = new URLSearchParams({ owner, capability: ownerCapability });
    return {
      type: "sse" as const,
      url: `http://127.0.0.1:${port}/sse?${query}`,
    };
  }
  return {
    type: "sse" as const,
    url: `http://127.0.0.1:${port}/sse`,
    headers: { "X-Browser-Owner": owner, "X-Browser-Capability": ownerCapability },
  };
}

function longLivedHttpMcp(agent: AgentKind | undefined, port: number) {
  return agent === "codex"
    ? { url: `http://127.0.0.1:${port}/mcp` }
    : { type: "sse" as const, url: `http://127.0.0.1:${port}/sse` };
}

// --- Catalog ---

const MCP_CATALOG: Record<string, RuntimeMcpCatalogEntry> = {
  playwright: {
    scopes: ["dm", "forum", "fork", "cron"],
    build({ userId, session, topicId, playwrightPort, playwrightCapability, agent }) {
      // Codex uses streamable HTTP while Claude and Maestro use SSE. Both
      // transports terminate at the same long-lived browser/profile server.
      if (playwrightPort && playwrightCapability) {
        const owner = browserOwnerForContext({ userId, session, topicId });
        if (!owner) return null;
        return playwrightTransport(playwrightPort, owner, playwrightCapability, agent);
      }
      // No port available — the playwright manager could not allocate one
      // for this turn. The previous behavior was to fall back to a per-turn
      // stdio chromium, but that made Chromium a child of the agent CLI
      // process tree, so cascade-kill on agent exit took the browser down
      // with it (visible in pm2 as "Chromium died with claude"). We now
      // omit the playwright entry from this turn's catalog AND fire two
      // side-effects:
      //   1. notify the host so it can push an alert into the current
      //      topic (rate-limited 5min per scope key);
      //   2. mark the (user, topic) as "playwright unavailable
      //      this turn" so the system-prompt builder can tell the model
      //      explicitly, instead of letting the model hallucinate a call
      //      to a tool whose schema silently vanished.
      _markPlaywrightUnavailable({
        userId,
        topic: session,
        agent,
      });
      return null;
    },
  },
  [RUNTIME_MCP_KEY]: {
    scopes: ["forum", "manager", "fork", "cron"],
    forumRequired: true,
    build({
      userId,
      session,
      topicId,
      queryId,
      agent,
      cwd,
      model,
      currentUserPrompt,
      autoContinue,
      visualTools,
      peerBridge,
    }) {
      if (!topicId || !agent) return null;
      return buildRuntimeMcpSpec(agent, {
        userId,
        topicId,
        topicTitle: session,
        queryId,
        cwd: cwd ?? resolveTopicWorkspaceDir(topicId),
        agent,
        model,
        currentUserPrompt,
        autoContinue,
        visualTools,
        peerBridge,
      });
    },
  },
  paddleocr: {
    scopes: ["dm", "forum", "fork", "cron"],
    build({ agent }) {
      return buildStdioMcpServer(agent, PADDLEOCR_SERVER, []);
    },
  },
  "token-stats": {
    scopes: ["dm", "forum", "manager", "cron"],
    forumRequired: true,
    build({ userId, agent }) {
      return buildStdioMcpServer(agent, TOKEN_STATS_SERVER, [`--user-id=${userId}`]);
    },
  },
  // Otium-owned shared task system. This is the only authoritative task/todo
  // surface across claude/codex/maestro; provider-native task stores are
  // blocked or ignored because they do not survive agent switches.
  task: {
    scopes: ["dm", "forum", "manager", "cron"],
    forumRequired: true,
    build({ userId, session, topicId, queryId, agent, peerBridge }) {
      if (peerBridge) {
        if (!topicId || !queryId) return null;
        const env = canonicalMcpBridgeEnv({
          surface: "task",
          userId,
          topicId,
          queryId,
          peerBridge,
        });
        return env
          ? buildStdioMcpServer(agent, CANONICAL_MCP_PROXY_SERVER, ["--surface=task"], env)
          : null;
      }
      const args = [`--user-id=${userId}`, `--topic=${session}`];
      if (topicId) args.push(`--topic-id=${topicId}`);
      return buildStdioMcpServer(agent, TASK_SERVER, args);
    },
  },
  "session-comm": {
    // Exposed in `manager` scope as well so the General-topic manager agent
    // can wake fresh-created topics via tell_session/ask_session right after
    // create_topic. Without this, a newly-created topic would stay in the
    // "fresh-start ready" state until the user manually visits it.
    scopes: ["forum", "fork", "manager"],
    forumRequired: true,
    build({ userId, session, topicId, agent, depth = 0, silent, peerBridge }) {
      const effectiveAgent = agent ?? FALLBACK_AGENT;
      const args = [
        `--user-id=${userId}`,
        `--topic=${session}`,
        ...(topicId ? [`--topic-id=${topicId}`] : []),
        `--depth=${depth}`,
        `--agent=${effectiveAgent}`,
        ...(silent ? ["--reply-only=true"] : []),
        ...(peerBridge ? [`--peer-host-query-id=${peerBridge.hostQueryId}`] : []),
      ];
      return buildStdioMcpServer(
        effectiveAgent,
        SESSION_COMM_SERVER,
        args,
        peerBridge ? peerSessionBridgeIpcEnv() : undefined,
      );
    },
  },
  wiki: {
    scopes: ["dm", "forum", "manager", "cron"],
    forumRequired: true,
    build({ userId, session, topicId, queryId, wikiTopicId, agent, peerBridge }) {
      if (peerBridge) {
        if (!topicId || !queryId) return null;
        const env = canonicalMcpBridgeEnv({
          surface: "wiki",
          userId,
          topicId,
          queryId,
          peerBridge,
        });
        return env
          ? buildStdioMcpServer(agent, CANONICAL_MCP_PROXY_SERVER, ["--surface=wiki"], env)
          : null;
      }
      const args = [`--user-id=${userId}`];
      // Prefer the REST topic id so save_wiki_entry writes filenames and SQLite
      // briefs keyed the same way the topic wiki API reads them.
      const resolvedWikiTopicId =
        wikiTopicId ?? topicId ?? (session !== "dm" ? session : undefined);
      if (resolvedWikiTopicId) args.push(`--topic-id=${resolvedWikiTopicId}`);
      args.push("--surface=wiki");
      return buildStdioMcpServer(agent, WIKI_SERVER, args);
    },
  },
  skills: {
    scopes: ["dm", "forum", "manager", "cron"],
    forumRequired: true,
    build({ userId, topicId, agent }) {
      const args = [`--user-id=${userId}`, "--surface=skills"];
      if (topicId) args.push(`--topic-id=${topicId}`);
      return buildStdioMcpServer(agent, WIKI_SERVER, args);
    },
  },
  "system-health": {
    scopes: ["dm", "forum", "manager", "cron"],
    forumRequired: true,
    build({ agent }) {
      return buildStdioMcpServer(agent, SYSTEM_HEALTH_SERVER, []);
    },
  },
  "background-bash": {
    scopes: ["forum"],
    build({ agent, bgBashPort }) {
      if (bgBashPort === undefined) return null;
      return longLivedHttpMcp(agent, bgBashPort);
    },
  },
  "agent-health": {
    scopes: ["forum", "manager", "cron"],
    forumRequired: true,
    build({ userId, agent }) {
      const args = [`--user-id=${userId}`];
      return buildStdioMcpServer(agent, AGENT_HEALTH_SERVER, args);
    },
  },
  vault: {
    scopes: ["dm", "forum", "manager", "cron"],
    // Credential references must never dead-end because a topic whitelist
    // omitted the broker while provider hooks correctly block raw expansion.
    forumRequired: true,
    build({ userId, agent }) {
      const args = [`--user-id=${userId}`];
      // Codex has no host-side PostToolUse redaction. Keep its Vault surface
      // broker-only and non-persistent: HTTPS responses are scrubbed before the
      // MCP result reaches Codex, while arbitrary shell could write a secret to
      // disk and reveal it through a later Read.
      if (agent === "codex") args.push("--http-only=true");
      return buildStdioMcpServer(agent, VAULT_SERVER, args);
    },
  },
};

// --- Derived catalog views ---

function namesInScope(scope: RuntimeMcpScope): string[] {
  return Object.entries(MCP_CATALOG)
    .filter(([, e]) => e.scopes.includes(scope))
    .map(([name]) => name);
}

/** All forum-eligible MCP server names, in display order. */
const allForumMcpServerNames: string[] = [];
export const ALL_FORUM_MCP_SERVER_NAMES: readonly string[] = allForumMcpServerNames;

/** Forum servers that cannot be removed via the enabled whitelist. */
const requiredForumMcpServers: string[] = [];
export const REQUIRED_FORUM_MCP_SERVERS: readonly string[] = requiredForumMcpServers;

/** Forum servers that can be toggled via the enabled whitelist (not required). */
const optionalForumMcpServers: string[] = [];
export const OPTIONAL_FORUM_MCP_SERVERS: readonly string[] = optionalForumMcpServers;

function refreshForumCatalogViews(): void {
  const all = namesInScope("forum");
  const required = Object.entries(MCP_CATALOG)
    .filter(([, entry]) => entry.scopes.includes("forum") && entry.forumRequired)
    .map(([name]) => name);
  allForumMcpServerNames.splice(0, allForumMcpServerNames.length, ...all);
  requiredForumMcpServers.splice(0, requiredForumMcpServers.length, ...required);
  optionalForumMcpServers.splice(
    0,
    optionalForumMcpServers.length,
    ...all.filter((name) => !required.includes(name)),
  );
}

refreshForumCatalogViews();

/**
 * Mount one MCP capability supplied by an optional node module.
 *
 * Registration happens once at node startup, never in the per-event hot path.
 * The returned cleanup closure only removes the exact entry installed by this
 * call, making module stop/restart safe.
 */
export function registerRuntimeMcpServer(name: string, entry: RuntimeMcpCatalogEntry): () => void {
  const key = name.trim();
  if (!key || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    throw new Error(`invalid runtime MCP server name: ${name}`);
  }
  if (MCP_CATALOG[key]) throw new Error(`runtime MCP server already registered: ${key}`);
  MCP_CATALOG[key] = entry;
  refreshForumCatalogViews();
  return () => {
    if (MCP_CATALOG[key] !== entry) return;
    delete MCP_CATALOG[key];
    refreshForumCatalogViews();
  };
}

/**
 * Format the active MCP config for display (used by get_mcp_config /
 * get_topic_mcp / configure_mcp response).
 *
 * In whitelist mode the DB stores only the user-chosen optional servers;
 * required servers are always active but never written to the whitelist.
 * This helper surfaces that split so the model never confuses "not in
 * whitelist" with "not active".
 */
export function formatMcpStatus(config: {
  enabled: string[] | null;
  extra?: Record<string, unknown>;
}): string[] {
  const extraNames = Object.keys(config.extra ?? {});

  if (config.enabled === null) {
    const total = ALL_FORUM_MCP_SERVER_NAMES.length + extraNames.length;
    return [
      `설정 방식: 기본값 (전체 활성)`,
      `활성 서버 (${total}개): ${[...ALL_FORUM_MCP_SERVER_NAMES, ...extraNames].join(", ")}`,
      `추가 서버: ${extraNames.length > 0 ? extraNames.join(", ") : "없음"}`,
    ];
  }

  // whitelist mode: stored list may or may not include required servers
  // (old entries might have them; new entries won't). Either way, split
  // by required vs optional for display.
  const optionalActive = config.enabled.filter((n) => !REQUIRED_FORUM_MCP_SERVERS.includes(n));
  const total = REQUIRED_FORUM_MCP_SERVERS.length + optionalActive.length + extraNames.length;
  return [
    `설정 방식: whitelist`,
    `필수 서버 (항상 활성, ${REQUIRED_FORUM_MCP_SERVERS.length}개): ${REQUIRED_FORUM_MCP_SERVERS.join(", ")}`,
    `선택 서버 (whitelist, ${optionalActive.length}개): ${optionalActive.length > 0 ? optionalActive.join(", ") : "없음"}`,
    `실제 활성 합계: ${total}개`,
    `추가 서버: ${extraNames.length > 0 ? extraNames.join(", ") : "없음"}`,
    ``,
    `선택 가능 서버 전체 (${OPTIONAL_FORUM_MCP_SERVERS.length}개): ${OPTIONAL_FORUM_MCP_SERVERS.join(", ")}`,
  ];
}

// --- Builders for each scope ---

// ── Node-assigned MCP servers (mcp-host manifest) ───────────────────
//
// The per-node MCP manifest (`negotium mcp add`) lives in @negotium/mcp-host,
// which depends on core — so core cannot read it directly. Instead the host
// process resolves the manifest at node start (ensuring long-lived http
// servers are running and have ports) and installs the result here. Entries
// then ride every eligible scope's catalog, subject to the same per-topic
// `enabled` whitelist as optional built-ins.

export type NodeMcpEntry =
  | { key: string; kind: "http"; port: number }
  | { key: string; kind: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

let nodeMcpEntries: NodeMcpEntry[] = [];

/** Install the node's assigned MCP servers. Last writer wins (host restart-safe). */
export function setNodeMcpServers(entries: NodeMcpEntry[]): void {
  nodeMcpEntries = entries.filter((entry) => !(entry.key in MCP_CATALOG));
  const dropped = entries.length - nodeMcpEntries.length;
  if (dropped > 0) {
    logger.warn({ dropped }, "setNodeMcpServers: entries shadowing built-in catalog keys ignored");
  }
}

export function getNodeMcpServers(): readonly NodeMcpEntry[] {
  return nodeMcpEntries;
}

function buildNodeMcpSpecs(
  agent: AgentKind | undefined,
  filter: (name: string) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of nodeMcpEntries) {
    if (!filter(entry.key)) continue;
    out[entry.key] =
      entry.kind === "http"
        ? longLivedHttpMcp(agent, entry.port)
        : {
            command: entry.command,
            args: entry.args ?? [],
            ...(entry.env ? { env: entry.env } : {}),
          };
  }
  return out;
}

function buildScope(
  scope: RuntimeMcpScope,
  ctx: RuntimeMcpBuildContext,
  filter: (name: string) => boolean = () => true,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(MCP_CATALOG)) {
    if (!entry.scopes.includes(scope)) continue;
    if (!filter(name)) continue;
    // `null` from build() means "skip this server for this turn" —
    // currently used by the playwright entry when no long-lived port
    // is available.
    const spec = entry.build(ctx);
    if (spec === null) continue;
    out[name] = spec;
  }
  // Node-assigned MCPs join every scope except cron (scheduled runs keep the
  // deliberately narrow built-in set).
  if (scope !== "cron") {
    Object.assign(out, buildNodeMcpSpecs(ctx.agent, filter));
  }
  return out;
}

/** DM session: catalog entries with `dm` scope, no whitelist. */
export function getDmMcpServers(opts: {
  userId: string;
  agent?: AgentKind;
  playwrightPort?: number;
  playwrightCapability?: string;
}) {
  return buildScope("dm", {
    userId: opts.userId,
    session: "dm",
    agent: opts.agent,
    playwrightPort: opts.playwrightPort,
    playwrightCapability: opts.playwrightCapability,
  });
}

/**
 * Manager session: lives in the caller's private General API topic. Owns topic CRUD,
 * invite/user admin, and cross-topic MCP toggling through `topic-admin`,
 * plus general utilities. Browser/OCR work belongs in dedicated topics, so
 * heavyweight Playwright/PaddleOCR tools are intentionally excluded here.
 * No whitelist — manager-scope catalog entries are loaded as-is.
 */
export function getManagerMcpServers(opts: {
  userId: string;
  session?: string;
  topicId?: string;
  queryId?: string;
  wikiTopicId?: string;
  agent?: AgentKind;
  cwd?: string;
  model?: string;
  currentUserPrompt?: string;
  playwrightPort?: number;
  playwrightCapability?: string;
  autoContinue?: boolean;
  visualTools?: boolean;
}) {
  if (!opts.topicId) {
    throw new Error("getManagerMcpServers: private General topicId is required");
  }
  const topicId = opts.topicId;
  return buildScope("manager", {
    userId: opts.userId,
    session: opts.session ?? "General",
    topicId,
    queryId: opts.queryId,
    wikiTopicId: opts.wikiTopicId ?? topicId,
    agent: opts.agent,
    cwd: opts.cwd,
    model: opts.model,
    currentUserPrompt: opts.currentUserPrompt,
    playwrightPort: opts.playwrightPort,
    playwrightCapability: opts.playwrightCapability,
    autoContinue: opts.autoContinue,
    visualTools: opts.visualTools,
  });
}

/**
 * Forum session: catalog entries with `forum` scope.
 * - `enabled === null` → all forum servers.
 * - `enabled` is an array → whitelist; required servers are always included.
 * - `extra` is merged on top, allowing one-off injections per topic.
 */
export function getForumMcpServers(opts: {
  userId: string;
  session: string;
  topicId?: string;
  queryId?: string;
  wikiTopicId?: string;
  agent: AgentKind;
  cwd?: string;
  model?: string;
  currentUserPrompt?: string;
  playwrightPort?: number;
  playwrightCapability?: string;
  bgBashPort?: number;
  autoContinue?: boolean;
  visualTools?: boolean;
  depth?: number;
  enabled?: string[] | null;
  extra?: Record<string, unknown>;
  silent?: boolean;
  peerBridge?: PeerRuntimeBridgeContext;
}) {
  const {
    userId,
    session,
    topicId,
    queryId,
    wikiTopicId,
    agent,
    cwd,
    model,
    currentUserPrompt,
    playwrightPort,
    playwrightCapability,
    depth = 0,
    enabled = null,
    extra = {},
    silent = false,
    bgBashPort,
    autoContinue,
    visualTools,
    peerBridge,
  } = opts;

  const filter = (name: string) => {
    if (silent && name === "task") return false;
    if (enabled === null) return true;
    return (
      enabled.includes(name) || (REQUIRED_FORUM_MCP_SERVERS as readonly string[]).includes(name)
    );
  };

  const base = buildScope(
    "forum",
    {
      userId,
      session,
      topicId,
      queryId,
      wikiTopicId,
      agent,
      cwd,
      model,
      currentUserPrompt,
      depth,
      playwrightPort,
      playwrightCapability,
      bgBashPort,
      autoContinue,
      visualTools,
      silent,
      peerBridge,
    },
    filter,
  );

  return { ...base, ...extra };
}

/**
 * Cron session: scheduled background run for a concrete API topic. Keep the
 * catalog narrower than forum scope: runtime delivery, topic memory/status,
 * OCR/vault utilities, and a caller-provided disposable Playwright port.
 */
export function getCronMcpServers(opts: {
  userId: string;
  session: string;
  topicId: string;
  queryId?: string;
  wikiTopicId?: string;
  agent: AgentKind;
  cwd?: string;
  model?: string;
  currentUserPrompt?: string;
  playwrightPort?: number;
  playwrightCapability?: string;
  visualTools?: boolean;
}) {
  return buildScope("cron", {
    userId: opts.userId,
    session: opts.session,
    topicId: opts.topicId,
    queryId: opts.queryId,
    wikiTopicId: opts.wikiTopicId ?? opts.topicId,
    agent: opts.agent,
    cwd: opts.cwd,
    model: opts.model,
    currentUserPrompt: opts.currentUserPrompt,
    playwrightPort: opts.playwrightPort,
    playwrightCapability: opts.playwrightCapability,
    autoContinue: false,
    visualTools: opts.visualTools,
  });
}

/**
 * Pick the right MCP server bundle for an agent query. DM/ephemeral sessions
 * get the DM bundle; forum sessions get the forum bundle with full options
 * forwarded. Returned shape is the Claude-SDK shape; Codex callers funnel it
 * through their own translator (`toCodexMcpServers`).
 */
export function getMcpServersForQuery(opts: AgentQueryOptions): Record<string, unknown> {
  if (opts.sessionType === "cron") {
    if (!opts.topicId) throw new Error("getMcpServersForQuery: cron sessionType requires topicId");
    return getCronMcpServers({
      userId: opts.userId || "default",
      session: opts.session || "cron",
      topicId: opts.topicId,
      queryId: opts.queryId,
      wikiTopicId: opts.wikiTopicId,
      agent: opts.agent,
      cwd: opts.cwd,
      model: opts.model,
      currentUserPrompt: opts.prompt,
      playwrightPort: opts.playwrightPort,
      playwrightCapability: opts.playwrightCapability,
      visualTools: opts.visualTools,
    });
  }
  if (opts.sessionType === "dm" || opts.sessionType === "ephemeral") {
    return getDmMcpServers({
      userId: opts.userId || "default",
      agent: opts.agent,
      playwrightPort: opts.playwrightPort,
      playwrightCapability: opts.playwrightCapability,
    });
  }
  if (opts.sessionType === "manager") {
    return getManagerMcpServers({
      userId: opts.userId || "default",
      session: opts.session,
      topicId: opts.topicId,
      queryId: opts.queryId,
      wikiTopicId: opts.wikiTopicId,
      agent: opts.agent,
      cwd: opts.cwd,
      model: opts.model,
      currentUserPrompt: opts.prompt,
      playwrightPort: opts.playwrightPort,
      playwrightCapability: opts.playwrightCapability,
      autoContinue: opts.autoContinue,
      visualTools: opts.visualTools,
    });
  }
  return getForumMcpServers({
    userId: opts.userId || "default",
    session: opts.session || "default",
    topicId: opts.topicId,
    queryId: opts.queryId,
    wikiTopicId: opts.wikiTopicId,
    agent: opts.agent,
    cwd: opts.cwd,
    model: opts.model,
    currentUserPrompt: opts.prompt,
    playwrightPort: opts.playwrightPort,
    playwrightCapability: opts.playwrightCapability,
    bgBashPort: opts.bgBashPort,
    autoContinue: opts.autoContinue,
    visualTools: opts.visualTools,
    depth: opts.depth,
    enabled: opts.mcpEnabled,
    extra: opts.mcpExtra,
    silent: opts.silent,
    peerBridge: opts.peerBridge,
  });
}
