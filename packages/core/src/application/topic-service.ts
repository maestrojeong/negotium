import { answerPendingAskUserQuestion } from "#agents/mcp-tools/ask-user";
import { WsHub } from "#bus";
import { abortRoom, getRoomQuery } from "#query/active-rooms";
import { getTopic } from "#storage/api-topics";
import { getRuntimeTurnLease } from "#storage/runtime-leases";
import { beginRuntimeTopicMaintenance } from "#storage/runtime-topic-state";
import { cancelRuntimeUserTurnRequestsBeforeEpoch } from "#storage/runtime-turn-requests";
import { type RegisterTopicOptions, registerTopic } from "#topics/create";
import { type DeleteTopicCascadeOptions, deleteTopicCascade } from "#topics/lifecycle";
import {
  compactTopicSession,
  type RestartTopicSessionResult,
  restartTopicSession,
} from "#topics/session";
import type { TopicDto } from "#types/api";

export type TopicServiceErrorCode = "TOPIC_NOT_FOUND" | "TOPIC_FORBIDDEN" | "TOPIC_PROTECTED";

export class TopicServiceError extends Error {
  constructor(
    readonly code: TopicServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TopicServiceError";
  }
}

function participantTopic(topicId: string, userId: string): TopicDto {
  const topic = getTopic(topicId);
  if (!topic?.participants.some((participant) => participant.userId === userId)) {
    throw new TopicServiceError("TOPIC_NOT_FOUND", "Topic not found");
  }
  return topic;
}

function ownerTopic(topicId: string, userId: string): TopicDto {
  const topic = participantTopic(topicId, userId);
  if (
    !topic.participants.some(
      (participant) => participant.userId === userId && participant.role === "owner",
    )
  ) {
    throw new TopicServiceError("TOPIC_FORBIDDEN", "Only a topic owner can perform this action");
  }
  return topic;
}

export interface DeleteUserTopicParams extends DeleteTopicCascadeOptions {
  topicId: string;
  userId: string;
}

export interface TopicSessionParams {
  topicId: string;
  userId: string;
  reason?: string;
}

export interface CompactUserTopicParams extends TopicSessionParams {
  compactSession?: typeof compactTopicSession;
}

export const topicService = {
  create(options: RegisterTopicOptions): TopicDto {
    return registerTopic(options);
  },

  async delete(params: DeleteUserTopicParams): Promise<void> {
    const topic = ownerTopic(params.topicId, params.userId);
    if (topic.kind === "manager" && !params.allowManager) {
      throw new TopicServiceError("TOPIC_PROTECTED", "Manager topics cannot be deleted");
    }
    await deleteTopicCascade(topic, params.userId, {
      ...(params.force !== undefined ? { force: params.force } : {}),
      ...(params.allowManager !== undefined ? { allowManager: params.allowManager } : {}),
      ...(params.skipArchive !== undefined ? { skipArchive: params.skipArchive } : {}),
    });
  },

  async reset(params: TopicSessionParams): Promise<RestartTopicSessionResult> {
    ownerTopic(params.topicId, params.userId);
    return restartTopicSession(params.topicId, params.userId, params.reason);
  },

  async compact(params: CompactUserTopicParams): Promise<RestartTopicSessionResult> {
    ownerTopic(params.topicId, params.userId);
    return (params.compactSession ?? compactTopicSession)(
      params.topicId,
      params.userId,
      params.reason,
    );
  },

  answerQuestion(topicId: string, messageId: string, label: string, userId: string) {
    participantTopic(topicId, userId);
    return answerPendingAskUserQuestion(topicId, messageId, label, userId);
  },

  abortTurn(topicId: string, userId: string): boolean {
    participantTopic(topicId, userId);
    const maintenance = beginRuntimeTopicMaintenance(topicId);
    if (!maintenance) return abortRoom(topicId);

    try {
      const activeQueryId = getRoomQuery(topicId)?.queryId ?? getRuntimeTurnLease(topicId)?.queryId;
      const cancelledQueryIds = cancelRuntimeUserTurnRequestsBeforeEpoch(
        topicId,
        maintenance.epoch,
      );
      const aborted = abortRoom(topicId);
      const terminalQueryIds = new Set(cancelledQueryIds);
      if (aborted && activeQueryId) terminalQueryIds.add(activeQueryId);
      for (const queryId of terminalQueryIds) {
        WsHub.get().broadcastAborted(topicId, queryId, "stopped");
      }
      return aborted || cancelledQueryIds.length > 0;
    } finally {
      maintenance.finish();
    }
  },
};
