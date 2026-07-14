import type { ConversationEntry } from "#storage/conversations";
import type { AgentKind, EffortLevel } from "#types";

/**
 * Inputs to a rollout synthesis call. The conversation log is provider-agnostic
 * — each registry's encoder reshapes it into the SDK-native rollout format
 * (claude jsonl / codex jsonl) so a subsequent `resume`/`resumeThread` picks
 * up the cross-agent dialogue as if it had always been native.
 */
export interface WriteRolloutOptions {
  /** Working directory the resumed session will report. */
  cwd: string;
  /** Provider-agnostic event log to encode. */
  entries: ConversationEntry[];
  /**
   * If set, the synthetic rollout is written using this id as the SDK
   * session/thread key — i.e. the file lands at the SAME path the SDK
   * already manages for an earlier run on this agent.
   */
  reuseSessionId?: string;
  /** Effective model the synthesized provider session will resume with. */
  model?: string;
  /** Effective reasoning effort recorded by providers whose rollout format carries it. */
  effort?: EffortLevel;
}

export interface WriteRolloutResult {
  sessionId: string;
  rolloutPath: string;
}

export interface ForkRegistryOptions {
  parentSessionId: string;
  cwd: string;
  userId: number | string;
  topicName: string;
  title?: string;
  /** Effective model/effort of the fork's first resumed turn. */
  model?: string;
  effort?: EffortLevel;
}

export interface ForkRegistryResult {
  forkId: string;
  rolloutPath: string;
}

export interface CleanupRolloutsOptions {
  cwd: string;
  sessionIds: string[];
}

/**
 * Per-agent runtime config registry. Centralizes the bits that differ between
 * agents so caller code can stay agent-agnostic.
 */
export interface AgentRegistry {
  kind: AgentKind;
  defaultModel: string;
  defaultEffort?: EffortLevel;
  expandModelAlias(s: string): string;
  validateModel(s: string): boolean;
  validEfforts: readonly EffortLevel[];
  validateEffort(s: EffortLevel): boolean;
  footerLabel(model: string, effort?: EffortLevel): string;
  writeRollout(opts: WriteRolloutOptions): WriteRolloutResult;
  forkSession(opts: ForkRegistryOptions): Promise<ForkRegistryResult>;
  cleanupRollouts(opts: CleanupRolloutsOptions): Promise<void>;
}
