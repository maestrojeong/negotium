import { runArchiverTurn } from "#agents/archiver";
import { countMemoryArchiveExchanges } from "#agents/memory-archive-policy";
import { logger } from "#platform/logger";
import { getRoomQuery } from "#query/active-rooms";
import { getMessagesForTopicAfterRowid } from "#storage/api-messages";
import { getTopic, getTopicMemoryOrigin } from "#storage/api-topics";
import { archiveTopicMessages } from "#storage/topic-archive";
import { claimTopicArchiveJob, settleTopicArchiveJob } from "#storage/topic-archive-state";

const DEFAULT_IDLE_DELAY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MIN_MESSAGES = 8;

type IdleArchiveStatus =
  | "scheduled"
  | "disabled"
  | "busy"
  | "topic-not-found"
  | "not-ai-invited"
  | "mention-only-channel"
  | "below-threshold"
  | "archived"
  | "deferred"
  | "empty";

export interface ActiveTopicArchiveOptions {
  reason: "idle" | "reset";
  minMessages: number;
  /** Preserve the raw snapshot but skip the memory agent below this exchange count. */
  minExchanges?: number;
  allowMentionOnly?: boolean;
  skipBusyCheck?: boolean;
  enabled?: boolean;
  isBusy?: (topicId: string) => boolean;
  onBusy?: (topicId: string, userId: string) => void;
  archiveMessages?: typeof archiveTopicMessages;
  launchArchiver?: typeof runArchiverTurn;
  settleArchiveJob?: typeof settleTopicArchiveJob;
  /** Called once when a launched memory turn finishes, successfully or not. */
  onSettled?: (success: boolean) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Cancel a pending idle snapshot before a topic is hard-deleted. */
export function cancelIdleArchiveForTopic(topicId: string): boolean {
  const timer = timers.get(topicId);
  if (!timer) return false;
  clearTimeout(timer);
  timers.delete(topicId);
  return true;
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

export function idleArchiveDelayMs(): number {
  return envPositiveInt("NEGOTIUM_IDLE_ARCHIVE_DELAY_MS", DEFAULT_IDLE_DELAY_MS);
}

export function idleArchiveMinMessages(): number {
  return envPositiveInt("NEGOTIUM_IDLE_ARCHIVE_MIN_MESSAGES", DEFAULT_MIN_MESSAGES);
}

export function idleArchiverEnabled(): boolean {
  return envFlagEnabled("NEGOTIUM_IDLE_ARCHIVER_ENABLED", true);
}

export function scheduleIdleArchiveForTopic(topicId: string, userId: string): IdleArchiveStatus {
  if (!idleArchiverEnabled()) return "disabled";

  const topic = getTopic(topicId);
  if (!topic) return "topic-not-found";
  if (!topic.agent) return "not-ai-invited";
  if (topic.aiMode === "mention") return "mention-only-channel";

  const existing = timers.get(topicId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(topicId);
    runIdleArchiveForTopic(topicId, userId);
  }, idleArchiveDelayMs());
  timer.unref?.();
  timers.set(topicId, timer);
  return "scheduled";
}

export function runIdleArchiveForTopic(topicId: string, userId: string): IdleArchiveStatus {
  if (!idleArchiverEnabled()) return "disabled";

  return archiveActiveTopicForMemory(topicId, userId, {
    reason: "idle",
    minMessages: idleArchiveMinMessages(),
  });
}

/**
 * Snapshot the unarchived tail of a live topic and launch its memory turn.
 * The shared rowid cursor prevents an explicit reset from re-archiving an
 * idle snapshot, and vice versa.
 */
export function archiveActiveTopicForMemory(
  topicId: string,
  userId: string,
  options: ActiveTopicArchiveOptions,
): IdleArchiveStatus {
  if (options.reason === "idle" && !(options.enabled ?? idleArchiverEnabled())) return "disabled";

  const busy = options.isBusy ? options.isBusy(topicId) : Boolean(getRoomQuery(topicId));
  if (!options.skipBusyCheck && busy) {
    if (options.onBusy) options.onBusy(topicId, userId);
    else scheduleIdleArchiveForTopic(topicId, userId);
    return "busy";
  }

  const topic = getTopic(topicId);
  if (!topic) return "topic-not-found";
  if (!topic.agent) return "not-ai-invited";
  if (!options.allowMentionOnly && topic.aiMode === "mention") return "mention-only-channel";

  let skipped: "below-threshold" | "empty" = "empty";
  let skipMemoryTurn = false;
  const claim = claimTopicArchiveJob(topicId, (afterRowid) => {
    const pending = getMessagesForTopicAfterRowid(topicId, afterRowid);
    const minMessages = options.minMessages;
    if (pending.length < minMessages) {
      skipped = "below-threshold";
      logger.debug(
        { topicId, topicTitle: topic.title, pending: pending.length, minMessages },
        "topic-memory-archiver: skipped below threshold",
      );
      return null;
    }
    const exchangeCount = countMemoryArchiveExchanges(pending);
    skipMemoryTurn = options.minExchanges !== undefined && exchangeCount < options.minExchanges;
    const archived = (options.archiveMessages ?? archiveTopicMessages)(topicId, topic.title, {
      afterRowid,
      reason: options.reason,
    });
    if (!archived) return null;
    return {
      archivePath: archived.path,
      messageCount: archived.messageCount,
      lastRowid: archived.lastRowid,
    };
  });
  if (!claim) return skipped;
  if (claim.kind === "busy") return "busy";

  const { job } = claim;
  if (skipMemoryTurn) {
    settleTopicArchiveJob(topicId, job.archivePath, true);
    logger.info(
      {
        topicId,
        topicTitle: topic.title,
        messageCount: job.messageCount,
        minExchanges: options.minExchanges,
        archive: job.archivePath,
        reason: options.reason,
      },
      "topic-memory-archiver: raw snapshot preserved below exchange threshold",
    );
    return "below-threshold";
  }
  const memoryTopic = getTopicMemoryOrigin(topicId) ?? topic;
  const launched = (options.launchArchiver ?? runArchiverTurn)({
    userId,
    topicId: memoryTopic.id,
    topicTitle: memoryTopic.title,
    archivePath: job.archivePath,
    messageCount: job.messageCount,
    mode: "active-topic",
    onSettled: (success) => {
      let settled = false;
      try {
        (options.settleArchiveJob ?? settleTopicArchiveJob)(topicId, job.archivePath, success);
        settled = true;
      } catch (err) {
        logger.warn(
          { err, topicId, archive: job.archivePath },
          "topic-memory-archiver: failed to settle archive job",
        );
      } finally {
        // A reset must never hold topic maintenance forever because durable
        // archive settlement failed. Report failure so callers can release
        // their fence while the unchanged running job remains retryable.
        options.onSettled?.(settled && success);
      }
    },
  });
  if (!launched) {
    settleTopicArchiveJob(topicId, job.archivePath, false);
    return "deferred";
  }
  logger.info(
    {
      topicId,
      topicTitle: topic.title,
      messageCount: job.messageCount,
      archive: job.archivePath,
      reason: options.reason,
    },
    "topic-memory-archiver: archived active topic snapshot",
  );
  return "archived";
}
