import { logger } from "#platform/logger";
import { getRoomQuery } from "#query/active-rooms";
import { getTopic } from "#storage/api-topics";
import { getRuntimeTurnLease } from "#storage/runtime-leases";
import { getTopicStats } from "#storage/token-stats";
import type { RestartTopicSessionResult } from "#topics/session";

const DEFAULT_IDLE_DELAY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CONTEXT_LIMIT_DELAY_MS = 1_000;
export const CONTEXT_LIMIT_COMPACT_PERCENT = 90;
// Mirrors the 80%-occupancy usage alert in `#runtime/turn-event-stream` at a
// lower bar: an idle topic gets auto-compacted once its *last known* context
// usage (as the provider itself reported it) has crossed the halfway mark.
const DEFAULT_MIN_CONTEXT_PERCENT = 50;

type IdleCompactStatus =
  | "scheduled"
  | "disabled"
  | "busy"
  | "topic-not-found"
  | "not-ai-invited"
  | "mention-only-channel"
  | "no-owner"
  | "below-threshold"
  | "compacted"
  | "failed";

export interface IdleCompactOptions {
  isBusy?: (topicId: string) => boolean;
  onBusy?: (topicId: string, userId: string) => void;
  minContextPercent?: number;
  reason?: string;
  /** Injected for tests; defaults to the real `getTopicStats`. */
  getStats?: typeof getTopicStats;
  /** Injected for tests; defaults to the real `compactTopicSession`. */
  compact?: (topicId: string, userId: string, reason: string) => Promise<RestartTopicSessionResult>;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const contextLimitTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel a pending idle-compact timer, e.g. before a topic is reset or deleted. */
export function cancelIdleCompactForTopic(topicId: string): boolean {
  const timer = timers.get(topicId);
  const contextLimitTimer = contextLimitTimers.get(topicId);
  if (timer) clearTimeout(timer);
  if (contextLimitTimer) clearTimeout(contextLimitTimer);
  timers.delete(topicId);
  contextLimitTimers.delete(topicId);
  return Boolean(timer || contextLimitTimer);
}

function envFlagEnabled(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function idleCompactDelayMs(): number {
  return envPositiveInt("NEGOTIUM_IDLE_COMPACT_DELAY_MS", DEFAULT_IDLE_DELAY_MS);
}

/** Percentage (0–100) of the provider's context window an idle topic must reach before it is auto-compacted. */
export function idleCompactMinContextPercent(): number {
  return envPositiveInt("NEGOTIUM_IDLE_COMPACT_MIN_CONTEXT_PERCENT", DEFAULT_MIN_CONTEXT_PERCENT);
}

export function idleCompactEnabled(): boolean {
  return envFlagEnabled("NEGOTIUM_IDLE_COMPACT_ENABLED", true);
}

/**
 * Schedule a check, `idleCompactDelayMs()` after the topic's last turn, that
 * compacts the session if (and only if) it is still idle and its context has
 * grown past the percent-of-window threshold. Runs alongside the memory
 * idle-archiver — this only trims what the model sees next turn; it does not
 * touch memory.
 */
export function scheduleIdleCompactForTopic(topicId: string, userId: string): IdleCompactStatus {
  if (!idleCompactEnabled()) return "disabled";

  const topic = getTopic(topicId);
  if (!topic) return "topic-not-found";
  if (!topic.agent) return "not-ai-invited";
  if (topic.aiMode === "mention") return "mention-only-channel";

  const existing = timers.get(topicId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(topicId);
    void runIdleCompactForTopic(topicId, userId);
  }, idleCompactDelayMs());
  timer.unref?.();
  timers.set(topicId, timer);
  return "scheduled";
}

/**
 * Schedule a near-immediate, non-preemptive compact after a completed turn
 * reports at least 90% context occupancy. A short delay lets the turn lease
 * unwind before the maintenance check; if it is still busy, retry shortly
 * without interrupting the live turn.
 */
export function scheduleContextLimitCompactForTopic(
  topicId: string,
  userId: string,
  contextTokens: number,
  contextWindow: number,
): IdleCompactStatus {
  if (!idleCompactEnabled()) return "disabled";
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return "below-threshold";
  const percent = (contextTokens / contextWindow) * 100;
  if (!Number.isFinite(percent) || percent < CONTEXT_LIMIT_COMPACT_PERCENT) {
    return "below-threshold";
  }

  const topic = getTopic(topicId);
  if (!topic) return "topic-not-found";
  if (!topic.agent) return "not-ai-invited";
  if (topic.aiMode === "mention") return "mention-only-channel";

  const existing = contextLimitTimers.get(topicId);
  if (existing) clearTimeout(existing);
  const retry = () =>
    scheduleContextLimitCompactForTopic(topicId, userId, contextTokens, contextWindow);
  const timer = setTimeout(() => {
    contextLimitTimers.delete(topicId);
    void runIdleCompactForTopic(topicId, userId, {
      minContextPercent: CONTEXT_LIMIT_COMPACT_PERCENT,
      reason: "context-limit-compact",
      onBusy: retry,
    });
  }, DEFAULT_CONTEXT_LIMIT_DELAY_MS);
  timer.unref?.();
  contextLimitTimers.set(topicId, timer);
  return "scheduled";
}

export async function runIdleCompactForTopic(
  topicId: string,
  userId: string,
  options: IdleCompactOptions = {},
): Promise<IdleCompactStatus> {
  if (!idleCompactEnabled()) return "disabled";

  const busy = options.isBusy
    ? options.isBusy(topicId)
    : Boolean(getRoomQuery(topicId) || getRuntimeTurnLease(topicId));
  if (busy) {
    if (options.onBusy) options.onBusy(topicId, userId);
    else scheduleIdleCompactForTopic(topicId, userId);
    return "busy";
  }

  const topic = getTopic(topicId);
  if (!topic) return "topic-not-found";
  if (!topic.agent) return "not-ai-invited";
  if (topic.aiMode === "mention") return "mention-only-channel";

  const owner = topic.participants.find((participant) => participant.role === "owner")?.userId;
  if (!owner) return "no-owner";

  const stats = (options.getStats ?? getTopicStats)(owner, topicId);
  const currentSession = stats.currentSession;
  if (!currentSession || currentSession.contextWindow <= 0) {
    logger.debug({ topicId }, "idle-compact: no provider-reported context usage yet, skipping");
    return "below-threshold";
  }
  const percent = (currentSession.contextTokens / currentSession.contextWindow) * 100;
  const minPercent = options.minContextPercent ?? idleCompactMinContextPercent();
  if (percent < minPercent) {
    logger.debug(
      { topicId, percent: Math.round(percent), minPercent },
      "idle-compact: skipped below context-usage threshold",
    );
    return "below-threshold";
  }

  const compact =
    options.compact ??
    (async (id: string, actorId: string, reason: string) => {
      // `preemptive: false`: idle-compact must never abort or cancel a turn
      // already in flight, local or remote — only a human explicitly running
      // `/compact` gets to interrupt work. See `compactTopicSession`.
      const { compactTopicSession } = await import("#topics/session");
      return compactTopicSession(id, actorId, reason, { preemptive: false });
    });

  try {
    const result = await compact(topicId, owner, options.reason ?? "idle-compact");
    if (result.busy) {
      logger.debug(
        { topicId, percent: Math.round(percent) },
        "idle-compact: topic became busy, rescheduling",
      );
      if (options.onBusy) options.onBusy(topicId, owner);
      else scheduleIdleCompactForTopic(topicId, owner);
      return "busy";
    }
    if (result.isError) {
      logger.warn(
        { topicId, percent: Math.round(percent), text: result.text },
        "idle-compact: failed",
      );
      return "failed";
    }
    logger.info(
      { topicId, percent: Math.round(percent) },
      "idle-compact: compacted an idle topic's context",
    );
    return "compacted";
  } catch (error) {
    logger.warn(
      { err: error, topicId, percent: Math.round(percent) },
      "idle-compact: unexpected failure while compacting an idle topic",
    );
    return "failed";
  }
}
