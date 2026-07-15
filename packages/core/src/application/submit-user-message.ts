import { randomUUID } from "node:crypto";
import { runtimeBus } from "#bus";
import { type StartAiTurnParams, startAiTurn } from "#runtime/turn-runner";
import { appendApiMessage } from "#storage/api-messages";
import type { MessageDto, TopicDto } from "#types/api";

export interface SubmitUserMessageParams {
  topic: TopicDto;
  userId: string;
  text: string;
  sourceAdapter?: string;
  allowAutoContinue?: boolean;
  onDispatched?: (queryId: string) => void;
  /** Override used by remote hosts and deterministic tests. */
  startTurn?: (params: StartAiTurnParams) => string | null;
}

export interface SubmitUserMessageResult {
  message: MessageDto;
  queryId: string | null;
}

/**
 * Canonical local-user submission flow. Persistence and publication happen
 * before dispatch so every channel observes the same message even when the AI
 * turn is rejected or deferred.
 */
export function submitUserMessage(params: SubmitUserMessageParams): SubmitUserMessageResult {
  const message: MessageDto = {
    id: randomUUID(),
    topicId: params.topic.id,
    authorId: params.userId,
    ...(params.sourceAdapter ? { sourceAdapter: params.sourceAdapter } : {}),
    text: params.text,
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(message);
  runtimeBus().broadcastMessage(params.topic.id, message);
  const queryId = (params.startTurn ?? startAiTurn)({
    topic: params.topic,
    userId: params.userId,
    prompt: params.text,
    allowAutoContinue: params.allowAutoContinue ?? true,
    onDispatched: params.onDispatched,
  });
  return { message, queryId };
}
