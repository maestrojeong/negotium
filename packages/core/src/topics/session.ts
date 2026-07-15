/** Topic session reset shared by every host surface. */

import { purgeTopicLogs } from "#agents/topic-cleanup";
import { WsHub } from "#bus";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { delay } from "#platform/delay";
import { abortRoom, getRoomQuery, interSessionQueue } from "#query/active-rooms";
import { clearQueryUsageAlert } from "#runtime/usage-alert";
import { clearTopicSessionId, getTopic, getTopicSessionId } from "#storage/api-topics";
import { getRuntimeTurnLease } from "#storage/runtime-leases";
import { beginRuntimeTopicMaintenance } from "#storage/runtime-topic-state";
import { cancelRuntimeUserTurnRequestsBeforeEpoch } from "#storage/runtime-turn-requests";

const RESET_TURN_WAIT_MS = 5_000;

export interface RestartTopicSessionResult {
  text: string;
  isError?: boolean;
}

/**
 * Reset provider-native and provider-neutral context without deleting the
 * topic or its visible message history. Mirrors Otium's `/new` contract.
 */
export async function restartTopicSession(
  topicId: string,
  userId: string,
  reason = "topic-session-restart",
): Promise<RestartTopicSessionResult> {
  const topic = getTopic(topicId);
  if (!topic) return { text: "Topic not found.", isError: true };
  if (topic.kind === "manager") {
    return { text: "The personal General session cannot be reset.", isError: true };
  }
  const owner = topic.participants.some(
    (participant) => participant.userId === userId && participant.role === "owner",
  );
  if (!owner) return { text: "Only the topic owner can reset the session.", isError: true };

  const maintenance = beginRuntimeTopicMaintenance(topicId);
  if (!maintenance) return { text: "Topic maintenance is already in progress.", isError: true };
  for (const queryId of cancelRuntimeUserTurnRequestsBeforeEpoch(topicId, maintenance.epoch)) {
    WsHub.get().broadcastAborted(topicId, queryId, "stopped");
  }

  try {
    // Work queued against the old context must not start while its files are
    // being purged. The shared epoch also invalidates queues held by peers.
    interSessionQueue.drop(topicId);
    if (abortRoom(topicId)) {
      const deadline = Date.now() + RESET_TURN_WAIT_MS;
      while ((getRoomQuery(topicId) || getRuntimeTurnLease(topicId)) && Date.now() < deadline) {
        await delay(50);
      }
      if (getRoomQuery(topicId) || getRuntimeTurnLease(topicId)) {
        return { text: "The active turn did not stop in time. Try again.", isError: true };
      }
    }

    if (!maintenance.isOwned()) {
      return { text: "Topic maintenance ownership was lost. Try again.", isError: true };
    }
    const sessionId = getTopicSessionId(topicId);
    await purgeTopicLogs({
      userId,
      topicName: topic.title,
      cwd: resolveTopicWorkspaceDir(topicId),
      extraSessions: topic.agent && sessionId ? [{ agent: topic.agent, sessionId }] : [],
    });
    clearTopicSessionId(topicId, reason);
    clearQueryUsageAlert(userId, topicId);
    return { text: `Session reset for "${topic.title}". The next message starts fresh.` };
  } finally {
    maintenance.finish();
  }
}
