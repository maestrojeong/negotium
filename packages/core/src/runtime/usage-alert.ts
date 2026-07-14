/**
 * Session-bloat alert.
 *
 * Adapted from the Telegram build's `telegram/topic/alert.ts`. After each AI turn
 * we weigh the turn's token usage; once the weighted total crosses the 1M mark we
 * post a single notice into the topic recommending `/new`, so the owner can start
 * a fresh session before context bloat degrades quality and cost.
 *
 * Deliberately quiet: at most ONE alert per session lifetime (until the next
 * `/new` clears it), so a long-running topic is never nagged turn after turn.
 *
 * The heavy lifting here (threshold, per-topic dedup, message text) is kept free
 * of I/O so it unit-tests cleanly; the caller in `runtime/turn-runner.ts` handles
 * the General/subagent guards and the actual posting.
 */
import type { TokenUsage } from "#types";

const THRESHOLD = 1_000_000;
// cache_read still reflects context bloat (history grows monotonically) but is
// heavily discounted vs fresh input/cache_creation, so the alert lands around a
// real session size of ~1.5M–2M rather than on the first big cache hit.
const CACHE_READ_WEIGHT = 0.3;

// Topics already warned this session, keyed by (user, topic) so the same topic
// under different users tracks independently. Cleared on session reset (`/new`).
const alerted = new Set<string>();

const alertKey = (userId: string, topicId: string) => `${userId}:${topicId}`;

/** Weighted session size: fresh input + cache_creation at full weight, cache_read discounted. */
export function weightedSessionTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    (usage.cacheCreationInputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) * CACHE_READ_WEIGHT
  );
}

function fmt(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

function buildUsageAlertText(topicTitle: string, usage: TokenUsage): string {
  const weighted = weightedSessionTokens(usage);
  return (
    `⚠️ "${topicTitle}" 세션이 커지고 있어요 (누적 약 ${fmt(weighted)} 토큰)\n\n` +
    `세션이 비대해지면 응답 품질이 떨어지고 비용이 늘어나요. 이 토픽에서 /new 를 입력하면 ` +
    `AI가 새 맥락으로 다시 시작합니다.\n\n` +
    `지금까지 주고받은 대화는 그대로 남아 있어요. 지워지는 건 AI가 내부적으로 기억하던 ` +
    `맥락뿐이라, 대화 내역이 사라질까 걱정하지 않아도 됩니다.`
  );
}

/**
 * If this turn's usage pushed the weighted session size past the 1M mark and the
 * topic hasn't been warned yet this session, return the alert text and mark it
 * warned; otherwise null. Fires at most once per session lifetime — the notice
 * won't repeat turn after turn — and re-arms only after `/new` clears it.
 */
export function nextUsageAlert(
  userId: string,
  topicId: string,
  topicTitle: string,
  usage: TokenUsage,
): string | null {
  if (weightedSessionTokens(usage) < THRESHOLD) return null;

  const key = alertKey(userId, topicId);
  if (alerted.has(key)) return null;
  alerted.add(key);

  return buildUsageAlertText(topicTitle, usage);
}

/** Re-arm the alert for a topic so a fresh session can warn again (called on `/new`). */
export function clearQueryUsageAlert(userId: string, topicId: string): void {
  alerted.delete(alertKey(userId, topicId));
}
