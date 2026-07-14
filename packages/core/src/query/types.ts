import type { ForkHandle } from "#agents/fork";
import type { AskReplySource } from "#storage/session-asks";
import type { AgentKind, EffortLevel } from "#types";

/**
 * What `handleAgentQuery` did with the request. Callers that own resources
 * tied to the params (e.g. an ask-fork rollout) use this to decide cleanup:
 * "ran"/"queued" transfer ownership to the query layer, "dropped" returns it.
 */
export type HandleAgentQueryOutcome = "ran" | "queued" | "dropped";

// --- Parameter interfaces ---

interface BaseQueryParams {
  chatId: number;
  userId: number;
  topicName: string;
  sessionId: string | null;
  prompt: string;
}

interface OutputParams {
  messageThreadId?: number;
  systemPrompt: string;
  cwd?: string;
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
  model?: string;
  silent?: boolean;
  effort?: EffortLevel;
  /** Override the topic-resolved agent backend. Used by callers like the
   *  archiver that run on ephemeral topics and need an explicit provider. */
  agent?: AgentKind;
}

interface InterSessionParams {
  from?: string; // "user" or sender session name
  depth?: number; // 0 = from user, 1+ = via tell_session
  // For silent ask-reply forks: caller's depth at ask time. When the fork's
  // reply is injected back to the caller, the caller resumes at this depth
  // so tell chain caps remain accurate across ask hops.
  fromDepth?: number;
  requestId?: string; // unique ID for dedup in interSessionQueue
  contextId?: string; // context ID for multi-turn inter-session conversations
  /**
   * Ask-fork rollout backing this inject's `sessionId`. Ownership travels
   * WITH the params: while the inject sits in `interSessionQueue` the rollout
   * must stay on disk (deleting it breaks the dequeued query's resume), and
   * `handleAgentQuery`'s finally removes it once the consuming query actually
   * finished (and no retry/requeue still references it).
   */
  forkHandle?: ForkHandle;
  /** Original ask_session replies represented by this inject, preserved across dequeueAll merges. */
  askReplySources?: AskReplySource[];
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
}

interface RetryGuardParams {
  _sessionRetried?: boolean; // guard against infinite retry on session expiry
}

export interface HandleAgentQueryParams
  extends BaseQueryParams,
    OutputParams,
    InterSessionParams,
    RetryGuardParams {}

// --- Abort reason ---

export enum AbortReason {
  None = "none",
  Internal = "internal", // replaced by a newer query on the same topic
  External = "external", // /abort command or abort_session via session-inbox
}
