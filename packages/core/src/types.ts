/**
 * Common context carried through the attachment/prompt-build pipeline.
 * Used by buildPromptFromMessage and related helpers.
 */
export interface SessionContext {
  userId: number;
  topicName?: string;
  userDir?: string;
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
}

export interface TokenUsage {
  /** Aggregate billable input across every model call made during this turn. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Tokens occupied by the latest model call, not aggregate turn spend. */
  contextTokens?: number;
  /** Provider-reported context window for the latest model call. */
  contextWindow?: number;
}

/** Agent identifier — one of the supported AI provider backends. */
export type AgentKind = "maestro" | "claude" | "codex";

export const SUPPORTED_AGENTS: readonly AgentKind[] = ["maestro", "claude", "codex"] as const;

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (SUPPORTED_AGENTS as readonly string[]).includes(value);
}

/**
 * Per-agent supported reasoning efforts. Single source of truth for both the
 * `EffortLevel` type and each registry's `validEfforts` runtime list — the
 * registries import these directly so adding a value in one place
 * propagates to validation, footer rendering, and zod enums.
 *
 * Claude SDK rejects 'minimal'; Codex SDK rejects 'max'. The two sets
 * intersect on low/medium/high/xhigh. Maestro (TS port) currently piggybacks
 * on the Anthropic provider, so its efforts mirror the Claude set; this can
 * narrow per-provider once Phase 5 lands.
 *
 * 'minimal' removed from codex: Codex API rejects it when default tools
 * (image_gen, web_search) are active, making agent sessions unusable.
 */
export const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
export const MAESTRO_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel =
  | (typeof CLAUDE_EFFORT_VALUES)[number]
  | (typeof CODEX_EFFORT_VALUES)[number]
  | (typeof MAESTRO_EFFORT_VALUES)[number];

/**
 * Runtime iteration list (used by zod enums and any callers that need to
 * loop over every accepted value). Manually ordered for readability; the
 * `satisfies` check fails the build if an entry here isn't covered by the
 * per-agent unions above.
 */
export const EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];

/**
 * Normalized events yielded by any agent provider (claudeProvider, codexProvider).
 * The handler/event-processor consumes these without caring which backend produced them.
 *
 * `user_message` is the lone "into-the-log" variant — no provider yields it.
 * The query handler writes it directly to the conversation log right before
 * `runAgent()` starts, so cross-agent rollout reconstruction can pair every
 * assistant turn with the user prompt that triggered it. Consumers that only
 * react to provider output (e.g. processAgentEvent) can safely ignore it.
 */
/**
 * Wire-safe projection of one task, carried by the `tasks` UnifiedEvent.
 *
 * This is also the on-disk shape of Otium's shared task store, so claude,
 * codex, and maestro render the same live panel from the same source of truth.
 */
export interface TaskSnapshot {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  /** Task ids this one is blocked by; omitted when empty. */
  blockedBy?: string[];
  /** Present-continuous label for spinners, when set. */
  activeForm?: string;
  /** Owner / agent name for multi-agent runs, when set. */
  owner?: string;
}

export type UnifiedEvent =
  | { type: "user_message"; content: string }
  | { type: "session"; sessionId: string }
  | {
      type: "tool_use";
      name: string;
      input: Record<string, unknown>;
      /** Provider-assigned id so the client can match tool_use→tool_result pairs. */
      toolUseId?: string;
    }
  | { type: "tool_progress"; toolName: string; elapsed: number }
  | { type: "tool_use_summary"; summary: string }
  // Full task-list snapshot (replace, not delta) from Otium's shared task
  // store. Provider-native task/todo stores are not authoritative.
  | { type: "tasks"; tasks: TaskSnapshot[] }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      metadata?: {
        truncatedForModel: boolean;
        originalBytes: number;
        returnedBytes: number;
        omittedBytes?: number;
        outputPath?: string;
      };
    }
  | { type: "text_delta"; content: string }
  | { type: "text"; content: string }
  | { type: "result"; content: string; stopReason: string; usage?: TokenUsage }
  | { type: "file"; path: string; source: string; origin: "tag" | "extension" }
  | { type: "error"; content: string }
  | { type: "status"; content: string };

export interface AgentInputAttachment {
  id: string;
  type: "image" | "file" | "audio";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
}

/** Worker-side runtime tools proxy user-facing state back to the canonical
 * hub topic identified here. */
export interface PeerRuntimeBridgeContext {
  hubCellId: string;
  hostTopicId: string;
  hostQueryId: string;
  canSpawnSubagents: boolean;
}

export interface AgentQueryOptions {
  agent: AgentKind;
  prompt: string;
  attachments?: AgentInputAttachment[];
  sessionId?: string | null;
  cwd: string;
  systemPrompt: string;
  userId?: string;
  session?: string;
  playwrightPort?: number;
  playwrightCapability?: string;
  bgBashPort?: number;
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
  /** API topic id (REST/WS world). Carries per-query topic context for MCP servers. */
  topicId?: string;
  /** API query id for the currently running turn. Used by runtime MCP tools. */
  queryId?: string;
  /** Optional wiki-memory topic id. Derived topics use their root origin here
   *  while other per-topic MCP servers keep `topicId` bound to the live room. */
  wikiTopicId?: string;
  /** Whether self-config MCP may enqueue an automatic continue turn after set_* changes. */
  autoContinue?: boolean;
  abortController?: AbortController;
  model?: string;
  depth?: number;
  agents?: Record<
    string,
    {
      description: string;
      prompt: string;
      model?: string;
      tools?: string[];
      maxTurns?: number;
      effort?: EffortLevel | number;
    }
  >;
  effort?: EffortLevel;
  /**
   * Per-API-call `max_tokens` ceiling on the assistant's output. Wired
   * through to the underlying provider request body for every agent
   * (claude/codex/maestro). Omit to inherit each provider SDK's per-model
   * default — for maestro that's the v0.1.21+ `getNativeMaxOutputTokens`
   * catalog (deepseek-pro=64K, deepseek-flash=32K).
   *
   * Pass an explicit number when a specific topic / surface needs a tighter
   * latency cap or a higher ceiling for long-form generation (legal
   * report writing, multi-K Write/Edit file bodies). Pre-0.1.21 maestro
   * builds silently clamped at 4096 and truncated outputs mid-string;
   * setting this field is now the supported way to lift that ceiling.
   */
  maxTokens?: number;
  /**
   * v0.1.22+: Claude-Code-style deferred tool catalog + `ToolSearch` built-in.
   *
   * Wired straight through to `maestro-agent-sdk`'s
   * `AgentQueryOptions.enableToolSearch`. When `true`, the maestro provider
   * registers every MCP tool as deferred — schemas stay off the wire until
   * the model promotes them via `ToolSearch("select:Name1,Name2")` or
   * `ToolSearch("keyword")`. Active set persists across resume.
   *
   * Otium's maestro provider supplies `true` when the caller leaves this
   * option unset, because most forum turns carry enough MCP surface for the
   * reminder-token savings to outweigh the first-use `ToolSearch` round-trip.
   * Callers can still pass `false` per call when a narrow surface or
   * latency-sensitive workflow is better served by eager MCP schemas.
   *
   * No-op for claude / codex agents — they have their own deferred-tool
   * machinery owned by their respective SDKs.
   */
  enableToolSearch?: boolean;
  /**
   * Claude-Code-compatible exact tool denylist. Maestro v0.1.42+ hides these
   * tools from provider schemas / ToolSearch and blocks dispatch if a stale
   * call still arrives. Claude maps this to its SDK option. Codex does not
   * support this name-based list; its provider-native multi-agent tool family
   * is disabled separately through the Codex feature config.
   */
  disallowedTools?: readonly string[];
  mcpEnabled?: string[] | null;
  peerBridge?: PeerRuntimeBridgeContext;
  mcpExtra?: Record<string, unknown>;
  /**
   * true for silent fork runs generating ask_session replies — restricts session-comm
   * outbound tools (ask/tell/abort) so the forked session can only produce text
   */
  silent?: boolean;
}

/** State file written to data/users/{userId}/active-queries/{topic}.json while a query is running. */
export interface QueryState {
  task?: string; // first 100 chars of prompt, newlines normalized
  since: string; // ISO timestamp
}
