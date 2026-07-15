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
import type { TokenUsage } from "#types";

const CONTEXT_ALERT_RATIO = 0.8;

// Topics already warned this session, keyed by (user, topic) so the same topic
// under different users tracks independently. Cleared on session reset (`/new`).
const alerted = new Set<string>();

const alertKey = (userId: string, topicId: string) => `${userId}:${topicId}`;

/** Latest-request context occupancy, or null when the provider did not report it. */
export function contextUsageRatio(usage: TokenUsage): number | null {
  if (
    usage.contextTokens === undefined ||
    usage.contextWindow === undefined ||
    !Number.isFinite(usage.contextTokens) ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextTokens < 0 ||
    usage.contextWindow <= 0
  ) {
    return null;
  }
  return usage.contextTokens / usage.contextWindow;
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

function buildUsageAlertText(topicTitle: string, usage: TokenUsage): string {
  const ratio = contextUsageRatio(usage) ?? 0;
  const used = usage.contextTokens ?? 0;
  const window = usage.contextWindow ?? 0;
  return (
    `⚠️ "${topicTitle}" context가 ${Math.round(ratio * 100)}% 찼어요 ` +
    `(${fmt(used)} / ${fmt(window)} 토큰)\n\n` +
    `이 토픽에서 /compact 를 입력하면 핵심 맥락을 요약해 이어가면서 context를 줄입니다. ` +
    `완전히 새로 시작하려면 /new 를 사용하세요.\n\n` +
    `두 명령 모두 지금까지 주고받은 보이는 대화 내역은 그대로 유지합니다.`
  );
}

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
  const ratio = contextUsageRatio(usage);
  if (ratio === null || ratio < CONTEXT_ALERT_RATIO) return null;

  const key = alertKey(userId, topicId);
  if (alerted.has(key)) return null;
  alerted.add(key);

  return buildUsageAlertText(topicTitle, usage);
}

/** Re-arm the alert for a topic so a fresh session can warn again (called on `/new`). */
export function clearQueryUsageAlert(userId: string, topicId: string): void {
  alerted.delete(alertKey(userId, topicId));
}
