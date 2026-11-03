/**
 * Resolution + reading behind the cross-topic `*_session_history_of` tools,
 * shared by the hosted `default-host.ts` and the stdio `server.ts`.
 *
 * Scope decision: a room's raw history is readable exactly when the room is
 * addressable through session-comm — it resolves in the caller's target
 * catalog (same surface, same workspace, the roster off `otium`, the hub's
 * reach set on it; never the current room or a manager room) — and, for a
 * subagent, when it is a room the subagent may `tell_session`. Remote
 * `node/topic` targets are not readable.
 */
import { mcpError } from "#mcp/mcp-helpers";
import {
  type SessionHistoryBudget,
  sessionHistoryBudgetFromEnv,
} from "#mcp/session-history-limits";
import {
  createSessionHistoryReader,
  type SessionHistoryResult,
  type SessionHistoryTarget,
} from "#mcp/session-history-reader";
import { getTopic } from "#storage/api-topics";
import { roomStatusPrincipal } from "./actor-policy";
import type { SessionHistoryOfReader } from "./history-tools";
import { canSubagentTellTarget, type SubagentTellIdentity } from "./tell-permissions";
import type { ValidateSessionTargetResult } from "./topic-catalog";

export interface SessionHistoryOfInput {
  callerUserId: string;
  /** The caller's session-comm catalog lookup — the whole visibility rule. */
  validateTarget: (to: string) => ValidateSessionTargetResult<string>;
  subagentIdentity: SubagentTellIdentity;
  budget?: SessionHistoryBudget;
}

export type ResolveHistoryTargetResult =
  | { ok: true; target: SessionHistoryTarget }
  | { ok: false; error: SessionHistoryResult };

export function resolveSessionHistoryTarget(
  input: Omit<SessionHistoryOfInput, "budget">,
  to: string,
): ResolveHistoryTargetResult {
  const validation = input.validateTarget(to);
  if (!validation.ok) return { ok: false, error: validation.error };
  const topicId = validation.target.topicId;
  if (!topicId) return { ok: false, error: mcpError(`Error: "${to}" has no topic id.`) };
  if (!canSubagentTellTarget(input.subagentIdentity, topicId)) {
    return {
      ok: false,
      error: mcpError(
        "Error: subagents can read session history only of topics they may tell_session (direct parents, direct children, or topics explicitly granted by an ancestor).",
      ),
    };
  }
  const topic = getTopic(topicId);
  // The manifest lives under the principal the room's turns run as: the
  // caller when it is a participant, else the room's owner (visible-but-not-
  // joined rooms on `otium`, design Q1) — the same rule peek_session reads by.
  const principal =
    roomStatusPrincipal({
      callerUserId: input.callerUserId,
      targetParticipants: topic?.participants,
    }) ?? input.callerUserId;
  return {
    ok: true,
    target: { userId: principal, topic: topic?.title ?? validation.target.name, label: to },
  };
}

/** One reader (one read budget) per session-comm server instance, i.e. per turn. */
export function createSessionHistoryOfReader(input: SessionHistoryOfInput): SessionHistoryOfReader {
  const reader = createSessionHistoryReader(input.budget ?? sessionHistoryBudgetFromEnv());
  const resolve = (to: string) => resolveSessionHistoryTarget(input, to);
  return {
    listBoundaries(to) {
      const resolved = resolve(to);
      return resolved.ok ? reader.listBoundaries(resolved.target) : resolved.error;
    },
    read(to, args) {
      const resolved = resolve(to);
      return resolved.ok ? reader.read(resolved.target, args) : resolved.error;
    },
    search(to, args) {
      const resolved = resolve(to);
      return resolved.ok ? reader.search(resolved.target, args) : resolved.error;
    },
  };
}
