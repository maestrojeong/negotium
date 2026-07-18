import { randomUUID } from "node:crypto";
import { runtimeBus } from "#bus";
import { appendApiMessage } from "#storage/api-messages";
import { db } from "#storage/forum-db";
import {
  findRuntimeGatewaySubmission,
  type RuntimeGatewaySubmission,
  recordRuntimeGatewaySubmission,
} from "#storage/runtime-gateway-submissions";
import { enqueueRuntimeUserTurnRequest } from "#storage/runtime-turn-requests";
import type { MessageDto, TopicDto } from "#types/api";

export interface SubmitRuntimeGatewayTurnParams {
  topic: TopicDto;
  userId: string;
  text: string;
  clientMessageId: string;
  requestId?: string;
  allowAutoContinue?: boolean;
}

export interface SubmitRuntimeGatewayTurnResult extends RuntimeGatewaySubmission {
  message: MessageDto;
  deduplicated: boolean;
}

function duplicateResult(submission: RuntimeGatewaySubmission): SubmitRuntimeGatewayTurnResult {
  return {
    ...submission,
    message: {
      id: submission.messageId,
      topicId: submission.topicId,
      authorId: submission.userId,
      sourceAdapter: "runtime-gateway",
      text: "",
      createdAt: submission.createdAt,
    },
    deduplicated: true,
  };
}

/**
 * Durable ingress for an authenticated external gateway. It deliberately
 * reuses the canonical message table and existing durable turn worker rather
 * than starting a second execution path.
 */
export function submitRuntimeGatewayTurn(
  params: SubmitRuntimeGatewayTurnParams,
): SubmitRuntimeGatewayTurnResult {
  const requestId = params.requestId ?? params.clientMessageId;
  const existing = findRuntimeGatewaySubmission(params.clientMessageId, requestId);
  if (existing) {
    if (
      existing.clientMessageId !== params.clientMessageId ||
      existing.requestId !== requestId ||
      existing.topicId !== params.topic.id ||
      existing.userId !== params.userId
    ) {
      throw new Error("clientMessageId or requestId is already bound to another turn");
    }
    return duplicateResult(existing);
  }

  const createdAt = new Date().toISOString();
  const message: MessageDto = {
    id: randomUUID(),
    topicId: params.topic.id,
    authorId: params.userId,
    sourceAdapter: "runtime-gateway",
    sourceMessageId: params.clientMessageId,
    text: params.text,
    createdAt,
  };
  const submission: RuntimeGatewaySubmission = {
    clientMessageId: params.clientMessageId,
    requestId,
    topicId: params.topic.id,
    messageId: message.id,
    userId: params.userId,
    createdAt,
  };

  try {
    db.transaction(() => {
      appendApiMessage(message);
      enqueueRuntimeUserTurnRequest({
        topicId: params.topic.id,
        userId: params.userId,
        prompt: params.text,
        allowAutoContinue: params.allowAutoContinue ?? true,
        requestId,
      });
      recordRuntimeGatewaySubmission(submission);
    })();
  } catch {
    const raced = findRuntimeGatewaySubmission(params.clientMessageId, requestId);
    if (raced) return duplicateResult(raced);
    throw new Error("failed to persist gateway turn idempotency record");
  }

  // Lifecycle is ordered on the durable bus: the acknowledgement precedes the
  // user message publication and eventual ai_active / tool / terminal events.
  runtimeBus().broadcastAiStatus(params.topic.id, {
    kind: "turn_accepted",
    requestId,
    clientMessageId: params.clientMessageId,
    messageId: message.id,
  });
  runtimeBus().broadcastMessage(params.topic.id, message);
  return { ...submission, message, deduplicated: false };
}
