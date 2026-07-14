import { runArchiverTurn } from "#agents/archiver";
import { logger } from "#platform/logger";
import { getRoomQuery } from "#query/active-rooms";
import { getMessagesForTopicAfterRowid } from "#storage/api-messages";
import { getTopic, getTopicMemoryOrigin } from "#storage/api-topics";
import { archiveTopicMessages } from "#storage/topic-archive";
import { getTopicArchiveState, setTopicArchiveState } from "#storage/topic-archive-state";

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
  | "empty";

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

  if (getRoomQuery(topicId)) {
    scheduleIdleArchiveForTopic(topicId, userId);
    return "busy";
  }

  const topic = getTopic(topicId);
  if (!topic) return "topic-not-found";
  if (!topic.agent) return "not-ai-invited";
  if (topic.aiMode === "mention") return "mention-only-channel";

  const state = getTopicArchiveState(topicId);
  const afterRowid = state?.lastArchivedRowid ?? 0;
  const pending = getMessagesForTopicAfterRowid(topicId, afterRowid);
  const minMessages = idleArchiveMinMessages();
  if (pending.length < minMessages) {
    logger.debug(
      { topicId, topicTitle: topic.title, pending: pending.length, minMessages },
      "idle-archiver: skipped below threshold",
    );
    return "below-threshold";
  }

  const archived = archiveTopicMessages(topicId, topic.title, {
    afterRowid,
    reason: "idle",
  });
  if (!archived) return "empty";

  setTopicArchiveState(topicId, archived.lastRowid, archived.path);
  const memoryTopic = getTopicMemoryOrigin(topicId) ?? topic;
  runArchiverTurn({
    userId,
    topicId: memoryTopic.id,
    topicTitle: memoryTopic.title,
    archivePath: archived.path,
    messageCount: archived.messageCount,
    mode: "active-topic",
  });
  logger.info(
    {
      topicId,
      topicTitle: topic.title,
      messageCount: archived.messageCount,
      archive: archived.path,
    },
    "idle-archiver: archived active topic snapshot",
  );
  return "archived";
}
