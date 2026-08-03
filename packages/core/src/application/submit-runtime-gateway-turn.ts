import { createHash, randomUUID } from "node:crypto";
import { appendApiMessage, getApiMessage } from "#storage/api-messages";
import { getTopicSessionId } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { appendRuntimeEvent } from "#storage/runtime-events";
import {
  backfillRuntimeGatewaySubmissionPayloadHash,
  findRuntimeGatewaySubmission,
  type RuntimeGatewaySubmission,
  recordRuntimeGatewaySubmission,
} from "#storage/runtime-gateway-submissions";
import { requestRuntimeTurnAbort } from "#storage/runtime-leases";
import { getRuntimeTopicEpoch } from "#storage/runtime-topic-state";
import { mergeRuntimeUserTurnRequest } from "#storage/runtime-turn-requests";
import type { MessageDto, TopicDto } from "#types/api";

export interface SubmitRuntimeGatewayTurnParams {
  topic: TopicDto;
  /** Canonical execution principal, normally `local`. */
  userId: string;
  /** Authenticated upstream author retained independently from execution. */
  actorUserId?: string;
  actorLabel?: string;
  /** Topic owner's credential namespace. */
  vaultUserId?: string;
  text: string;
  clientMessageId: string;
  requestId?: string;
  allowAutoContinue?: boolean;
}

export interface SubmitRuntimeGatewayTurnResult extends RuntimeGatewaySubmission {
  message: MessageDto;
  deduplicated: boolean;
}

function duplicateResult(
  submission: RuntimeGatewaySubmission,
  params: SubmitRuntimeGatewayTurnParams,
  requestId: string,
  actorUserId: string,
  payloadHash: string,
): SubmitRuntimeGatewayTurnResult {
  const message = getApiMessage(submission.topicId, submission.messageId);
  if (!message) throw new Error("gateway submission references a missing canonical message");
  if (submission.payloadHash && submission.payloadHash !== payloadHash) {
    throw new RuntimeGatewayIdempotencyConflictError();
  }
  if (
    // `MessageDto.authorName` is never persisted — `api_messages` has no
    // `author_name` column, so a message fetched back from storage always
    // has `authorName: undefined`. Comparing it here would either always
    // fail (once `actorLabel` is set) or always pass (once it's cleared);
    // it is dropped in favor of the fields that actually round-trip.
    (!submission.payloadHash &&
      (message.authorId !== actorUserId || message.text !== params.text)) ||
    submission.clientMessageId !== params.clientMessageId ||
    submission.requestId !== requestId ||
    submission.topicId !== params.topic.id ||
    submission.userId !== params.userId
  ) {
    throw new RuntimeGatewayIdempotencyConflictError();
  }
  if (!submission.payloadHash) {
    // Pre-0.2.5 rows never recorded `actorLabel`/`vaultUserId`/
    // `allowAutoContinue` anywhere retrievable, so this replay could not
    // actually be checked against them above. Adopt this call's hash as
    // canonical for the key now, so any *later* replay with a different
    // actor label, Vault, or auto-continue flag is caught instead of
    // silently reusing this ACK forever.
    backfillRuntimeGatewaySubmissionPayloadHash(submission.clientMessageId, payloadHash);
  }
  return {
    ...submission,
    payloadHash: submission.payloadHash ?? payloadHash,
    message,
    deduplicated: true,
  };
}

function gatewayPayloadHash(
  params: SubmitRuntimeGatewayTurnParams,
  requestId: string,
  actorUserId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.topic.id,
        params.userId,
        actorUserId,
        params.actorLabel ?? null,
        params.vaultUserId ?? null,
        params.text,
        params.clientMessageId,
        requestId,
        params.allowAutoContinue ?? true,
      ]),
    )
    .digest("hex");
}

/**
 * Durable ingress for an authenticated external gateway. It deliberately
 * reuses the canonical message table and existing durable turn worker rather
 * than starting a second execution path.
 */
/**
 * The supplied idempotency key already identifies a different turn.
 *
 * A distinct type rather than a plain `Error` because the control plane maps
 * this to 409, and it must not be confused with a *missing* `clientMessageId`,
 * which is a malformed request (400).
 */
export class RuntimeGatewayIdempotencyConflictError extends Error {
  constructor(message = "clientMessageId or requestId is already bound to another turn") {
    super(message);
    this.name = "RuntimeGatewayIdempotencyConflictError";
  }
}

export function submitRuntimeGatewayTurn(
  params: SubmitRuntimeGatewayTurnParams,
): SubmitRuntimeGatewayTurnResult {
  const requestId = params.requestId ?? params.clientMessageId;
  const actorUserId = params.actorUserId ?? params.userId;
  const payloadHash = gatewayPayloadHash(params, requestId, actorUserId);
  const existing = findRuntimeGatewaySubmission(params.clientMessageId, requestId);
  if (existing) {
    return duplicateResult(existing, params, requestId, actorUserId, payloadHash);
  }

  const createdAt = new Date().toISOString();
  const message: MessageDto = {
    id: randomUUID(),
    topicId: params.topic.id,
    authorId: actorUserId,
    authorName: params.actorLabel,
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
    ackCursor: 0,
    messageCursor: 0,
    payloadHash,
  };

  try {
    db.transaction(() => {
      appendApiMessage(message, { notify: false });
      mergeRuntimeUserTurnRequest({
        topicId: params.topic.id,
        userId: params.userId,
        userMessages: [
          {
            prompt: params.text,
            actorUserId,
            ...(params.actorLabel ? { actorLabel: params.actorLabel } : {}),
          },
        ],
        allowAutoContinue: params.allowAutoContinue ?? true,
        requestId,
        topicEpoch: getRuntimeTopicEpoch(params.topic.id),
        execution: {
          sessionId: getTopicSessionId(params.topic.id),
          sessionIdSpecified: true,
          conversationPrompts: [params.text],
          loggedUserMessageCount: 0,
          vaultUserId: params.vaultUserId,
        },
      });
      const acceptedEvent = appendRuntimeEvent("runtime-gateway-ingress", {
        type: "ai-status",
        topicId: params.topic.id,
        payload: {
          kind: "turn_accepted",
          requestId,
          clientMessageId: params.clientMessageId,
          messageId: message.id,
        },
      });
      const messageEvent = appendRuntimeEvent("runtime-gateway-ingress", {
        type: "message",
        topicId: params.topic.id,
        payload: message,
      });
      submission.ackCursor = acceptedEvent.seq;
      submission.messageCursor = messageEvent.seq;
      recordRuntimeGatewaySubmission(submission);
    })();
  } catch {
    const raced = findRuntimeGatewaySubmission(params.clientMessageId, requestId);
    if (raced) return duplicateResult(raced, params, requestId, actorUserId, payloadHash);
    throw new Error("failed to persist gateway turn idempotency record");
  }

  // A new human message steers the active topic turn. The durable replacement
  // is committed first; the provider observes this abort on its next lease
  // heartbeat and the worker resumes the merged batch after unwind.
  requestRuntimeTurnAbort(params.topic.id, "internal");

  return { ...submission, message, deduplicated: false };
}
