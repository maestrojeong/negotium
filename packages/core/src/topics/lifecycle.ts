/**
 * Topic hard-delete with full memory preservation — the single source of
 * truth shared by every host surface (negotium MCP `delete_topic`, CLI, any
 * channel adapter). Ported from otium runtime-api `api/topic-lifecycle.ts`
 * minus peer/cron cascades (deferred subsystems on a standalone node).
 */

import { rmSync } from "node:fs";
import { runArchiverTurn } from "#agents/archiver";
import { cancelIdleArchiveForTopic } from "#agents/idle-archiver";
import { type PurgeSessionRef, purgeTopicLogs } from "#agents/topic-cleanup";
import { WsHub } from "#bus";
import { killBgBash } from "#platform/background-bash/manager";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import { delay } from "#platform/delay";
import { logger } from "#platform/logger";
import { deleteTopicProfileDir } from "#platform/playwright/manager";
import { abortRoom, getRoomQuery, interSessionQueue } from "#query/active-rooms";
import { cleanupSessionInboxFiles } from "#query/session-inbox-cleanup";
import { clearQueryState } from "#query/state";
import { cancelAskCallbacksForTopic } from "#runtime/ask-callbacks";
import { deleteFilesForTopic } from "#runtime/file-hooks";
import { clearQueryUsageAlert } from "#runtime/usage-alert";
import { deleteTopicVisuals } from "#runtime/visual-store";
import { deleteMessagesForTopic } from "#storage/api-messages";
import { deleteTopicBrief } from "#storage/api-topic-brief";
import { deleteApiTopicConfig } from "#storage/api-topic-config";
import {
  deleteTopic as deleteTopicDB,
  getTopicMemoryOrigin,
  getTopicSessionId,
  reparentTopicChildren,
} from "#storage/api-topics";
import { getRuntimeTurnLease } from "#storage/runtime-leases";
import { beginRuntimeTopicMaintenance } from "#storage/runtime-topic-state";
import {
  cancelRuntimeUserTurnRequests,
  cancelRuntimeUserTurnRequestsBeforeEpoch,
} from "#storage/runtime-turn-requests";
import { deletePendingAsksForTopic } from "#storage/session-asks";
import { archiveTopicMessages } from "#storage/topic-archive";
import { deleteTopicArchiveState } from "#storage/topic-archive-state";
import type { TopicDto } from "#types/api";

const DELETE_TURN_WAIT_MS = 5_000;

async function abortAndWaitForTopic(topicId: string): Promise<boolean> {
  // Drop first: the dying turn's finally block must not dispatch queued work.
  interSessionQueue.drop(topicId);
  cancelIdleArchiveForTopic(topicId);
  const aborted = abortRoom(topicId);
  if (!aborted) return true;

  logger.info({ topicId }, "deleteTopicCascade: aborted in-flight turn");
  const deadline = Date.now() + DELETE_TURN_WAIT_MS;
  while ((getRoomQuery(topicId) || getRuntimeTurnLease(topicId)) && Date.now() < deadline) {
    await delay(50);
  }
  if (getRoomQuery(topicId) || getRuntimeTurnLease(topicId)) {
    logger.warn(
      { topicId, timeoutMs: DELETE_TURN_WAIT_MS },
      "deleteTopicCascade: timed out waiting for in-flight turn cleanup",
    );
    return false;
  }
  return true;
}

function currentSessionRef(topic: TopicDto, sessionId: string | null): PurgeSessionRef[] {
  return topic.agent && sessionId ? [{ agent: topic.agent, sessionId }] : [];
}

async function cleanupParticipantResources(
  topic: TopicDto,
  userIds: string[],
  sessionId: string | null,
  cwd: string,
): Promise<void> {
  for (const [index, participantUserId] of userIds.entries()) {
    try {
      await purgeTopicLogs({
        userId: participantUserId,
        topicName: topic.title,
        cwd,
        // The DB only has one current native session. Its unified-log owner is
        // not knowable after multi-user turns, so include it once as a fallback;
        // every participant manifest is still scanned for older sessions.
        extraSessions: index === 0 ? currentSessionRef(topic, sessionId) : [],
      });
    } catch (err) {
      logger.warn(
        { err, topicId: topic.id, userId: participantUserId },
        "deleteTopicCascade: participant rollout cleanup failed",
      );
    }

    cleanupSessionInboxFiles(participantUserId, topic.id, topic.title);
    clearQueryState(participantUserId, topic.title);
    clearQueryUsageAlert(participantUserId, topic.id);
    deletePendingAsksForTopic({ userId: participantUserId, topicName: topic.title });
  }
}

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

export class TopicTurnStillActiveError extends Error {
  readonly code = "TOPIC_TURN_STILL_ACTIVE";
  readonly topicId: string;

  constructor(topicId: string) {
    super(
      "The active turn did not stop in time; deletion was blocked. Use force-delete explicitly.",
    );
    this.name = "TopicTurnStillActiveError";
    this.topicId = topicId;
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
 *   3. purge topic-owned runtime/filesystem/adapter state.
 *   4. delete messages + config + brief + the topic row.
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
  if (topicId === GENERAL_TOPIC_ID || (topic.kind === "manager" && !options.allowManager)) {
    logger.warn({ topicId }, "deleteTopicCascade: refused to delete essential topic");
    return;
  }
  const force = options.force === true;
  const maintenance = beginRuntimeTopicMaintenance(topicId);
  if (!maintenance) throw new Error("Topic maintenance is already in progress.");
  let deleted = false;
  const cancelledQueryIds = cancelRuntimeUserTurnRequestsBeforeEpoch(topicId, maintenance.epoch);
  for (const queryId of cancelledQueryIds) {
    WsHub.get().broadcastAborted(topicId, queryId, "stopped");
  }

  try {
    // Wait for the aborted turn's final session/log writes before taking the
    // forensic snapshot. Normal deletion blocks on timeout; only the explicit
    // force-delete escape hatch may proceed while a provider is still wedged.
    const turnStopped = await abortAndWaitForTopic(topicId);
    if (!turnStopped && !force) throw new TopicTurnStillActiveError(topicId);
    if (!maintenance.isOwned()) throw new Error("Topic maintenance ownership was lost.");
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
          // A root topic is about to disappear, so its durable summary is file
          // + General memory only. Passing the deleted id to wiki MCP would let
          // the detached archiver recreate an orphan api_topic_brief row later.
          ...(memoryTopic.id !== topicId ? { topicId: memoryTopic.id } : {}),
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

    const sessionId = getTopicSessionId(topicId);
    const cwd = resolveTopicWorkspaceDir(topicId);
    const participantUserIds = Array.from(
      new Set([userId, ...topic.participants.map((participant) => participant.userId)]),
    );

    // Topic ids are the ownership keys for these processes/directories. Unlike
    // Clawgram's title-keyed regular profiles, none can be reused after a hard
    // delete because a recreated topic receives a fresh id.
    killBgBash(userId, topicId);
    deleteTopicProfileDir(userId, topicId);
    cancelAskCallbacksForTopic(topicId);

    await cleanupParticipantResources(topic, participantUserIds, sessionId, cwd);
    try {
      await deleteFilesForTopic(topicId);
    } catch (err) {
      logger.warn({ err, topicId }, "deleteTopicCascade: host file cleanup failed");
    }
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, topicId, cwd }, "deleteTopicCascade: workspace cleanup failed");
    }

    deleteTopicVisuals(topicId);
    deleteTopicArchiveState(topicId);
    deleteMessagesForTopic(topicId);
    deleteApiTopicConfig(topicId);
    deleteTopicBrief(topicId);
    const reparentedChildIds = reparentTopicChildren(topicId, topic.parentTopicId ?? null);
    const rowDeleted = deleteTopicDB(topicId, { allowManager: options.allowManager });
    if (!rowDeleted) {
      logger.warn({ topicId }, "deleteTopicCascade: topic row was not deleted");
      return;
    }
    deleted = true;
    // Mirror the deletion onto the bus so channel adapters (Telegram forum
    // threads, web clients, …) can drop their bindings for the topic.
    WsHub.get().broadcastTopicDeleted(topicId);
    for (const childId of reparentedChildIds) WsHub.get().broadcastTopicUpdated(childId);
  } finally {
    if (deleted) {
      for (const queryId of cancelRuntimeUserTurnRequests(topicId)) {
        WsHub.get().broadcastAborted(topicId, queryId, "stopped");
      }
      maintenance.finish({ deleteState: true });
    } else {
      maintenance.finish();
    }
  }
}
