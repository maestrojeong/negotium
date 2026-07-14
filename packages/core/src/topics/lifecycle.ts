/**
 * Topic hard-delete with full memory preservation — the single source of
 * truth shared by every host surface (negotium MCP `delete_topic`, CLI, any
 * channel adapter). Ported from otium runtime-api `api/topic-lifecycle.ts`
 * minus peer/cron cascades (deferred subsystems on a standalone node).
 */

import { runArchiverTurn } from "#agents/archiver";
import { WsHub } from "#bus";
import { logger } from "#platform/logger";
import { abortRoom, interSessionQueue } from "#query/active-rooms";
import { deleteMessagesForTopic } from "#storage/api-messages";
import { deleteTopicBrief } from "#storage/api-topic-brief";
import { deleteApiTopicConfig } from "#storage/api-topic-config";
import { deleteTopic as deleteTopicDB, getTopicMemoryOrigin } from "#storage/api-topics";
import { archiveTopicMessages } from "#storage/topic-archive";
import type { TopicDto } from "#types/api";

export class TopicArchiveRequiredError extends Error {
  readonly code = "TOPIC_ARCHIVE_FAILED";
  readonly topicId: string;

  constructor(topicId: string, cause: unknown) {
    super("Topic archive failed; deletion was blocked to avoid losing conversation history.");
    this.name = "TopicArchiveRequiredError";
    this.topicId = topicId;
    this.cause = cause;
  }
}

export interface DeleteTopicCascadeOptions {
  force?: boolean;
  /** Account deletion may remove that account's otherwise-protected private General. */
  allowManager?: boolean;
  /** Account deletion must not recreate a private General via the archiver. */
  skipArchive?: boolean;
}

/**
 * Sequence (memory BEFORE wipe):
 *   1. archiveTopicMessages → dump SQLite conversation to the shared wiki
 *      `archive/` as forensic JSONL.
 *   2. runArchiverTurn → background wiki-archiver (summaries/articles/brief).
 *   3. delete messages + config + brief + the topic row.
 *
 * Step 1 is required by default: if the raw archive cannot be written, deletion
 * is blocked to avoid losing conversation history. Pass `force: true` only for
 * an explicit force-delete escape hatch. Step 2 is best-effort because the raw
 * transcript has already been preserved.
 * Caller is responsible for guards (essential-topic / owner / existence).
 */
export async function deleteTopicCascade(
  topic: TopicDto,
  userId: string,
  options: DeleteTopicCascadeOptions = {},
): Promise<void> {
  const topicId = topic.id;
  if (topic.kind === "manager" && !options.allowManager) {
    logger.warn({ topicId }, "deleteTopicCascade: refused to delete essential topic");
    return;
  }
  // Stop the room before wiping it: a turn still streaming after deletion
  // would resurrect ghost messages/threads through the bus, and a deferred
  // inject draining later would re-run against the missing topic.
  const aborted = abortRoom(topicId);
  interSessionQueue.drop(topicId);
  if (aborted) logger.info({ topicId }, "deleteTopicCascade: aborted in-flight turn");
  const force = options.force === true;
  let archived: ReturnType<typeof archiveTopicMessages> = null;

  if (!options.skipArchive) {
    try {
      archived = archiveTopicMessages(topicId, topic.title);
    } catch (err) {
      if (!force) {
        logger.warn(
          { err, topicId },
          "deleteTopicCascade: archive failed - blocking delete unless force=true",
        );
        throw new TopicArchiveRequiredError(topicId, err);
      }
      logger.warn(
        { err, topicId },
        "deleteTopicCascade: archive failed but force=true - continuing with hard delete",
      );
    }
  }

  if (archived) {
    try {
      const memoryTopic = getTopicMemoryOrigin(topicId) ?? topic;
      runArchiverTurn({
        userId,
        topicId: memoryTopic.id,
        topicTitle: memoryTopic.title,
        archivePath: archived.path,
        messageCount: archived.messageCount,
      });
    } catch (err) {
      logger.warn(
        { err, topicId, archive: archived.path },
        "deleteTopicCascade: background archiver launch failed - raw archive preserved",
      );
    }
  }

  deleteMessagesForTopic(topicId);
  deleteApiTopicConfig(topicId);
  deleteTopicBrief(topicId);
  deleteTopicDB(topicId, { allowManager: options.allowManager });
  // Mirror the deletion onto the bus so channel adapters (Telegram forum
  // threads, web clients, …) can drop their bindings for the topic.
  WsHub.get().broadcastTopicDeleted(topicId);
}
