/**
 * Session-bloat alert.
 *
 * Adapted from the Telegram build's `telegram/topic/alert.ts`. After each AI turn
 * we inspect the provider's latest-request context occupancy. Aggregate turn
 * input is deliberately not used: a tool-heavy turn can make many cached model
 * calls and report millions of billable input tokens while the actual context
 * window remains mostly empty.
 *
 * Deliberately quiet: at most ONE alert per session lifetime (until the next
 * `/new` clears it), so a long-running topic is never nagged turn after turn.
 *
 * The heavy lifting here (threshold, per-topic dedup, message text) is kept free
 * of I/O so it unit-tests cleanly; the caller in `runtime/turn-runner.ts` handles
 * the General/subagent guards and the actual posting.
 */
import {
  clearContextWarning,
  createContextWarningState,
  nextContextWarning,
} from "#runtime/context-warning";
import type { TokenUsage } from "#types";

export { contextUsageRatio } from "#runtime/context-warning";

// Topics already warned this session, keyed by (user, topic) so the same topic
// under different users tracks independently. Cleared on session reset (`/new`).
const alertState = createContextWarningState();

const alertKey = (userId: string, topicId: string) => `${userId}:${topicId}`;

/**
 * If the latest request filled at least 80% of the provider context window and
 * the topic hasn't been warned yet this session, return the alert text and mark
 * it warned; otherwise null. Fires at most once per session lifetime — the
 * notice won't repeat turn after turn — and re-arms only after `/new` clears it.
 */
export function nextUsageAlert(
  userId: string,
  topicId: string,
  topicTitle: string,
  usage: TokenUsage,
): string | null {
  const key = alertKey(userId, topicId);
  return nextContextWarning(alertState, { key, topicTitle, usage, supportsCompact: true });
}

/** Re-arm the alert for a topic so a fresh session can warn again (called on `/new`). */
export function clearQueryUsageAlert(userId: string, topicId: string): void {
  clearContextWarning(alertState, alertKey(userId, topicId));
}
