import { createHash, randomUUID } from "node:crypto";
import { resolveAttachmentByFileId } from "#runtime/file-hooks";
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
import { recordTopicToolCapabilities } from "#storage/topic-tool-capabilities";
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
  /**
   * Whether this message should also run the AI. Defaults to true.
   *
   * A host whose room has the AI removed, or set to mention-only, still needs
   * the message in the canonical transcript — otherwise Terminal and Telegram
   * see a room with holes in it. `false` records the message and acknowledges
   * it exactly as usual, and only declines to queue the turn.
   */
  respond?: boolean;
  /** Answer inside this thread instead of the room's main flow (S-13). */
  threadRootId?: string;
  /** Host-uploaded file ids already staged in this node's file store. */
  attachments?: string[];
  /**
   * Capability minted by the calling adapter, forwarded to the turn's runtime
   * MCP. Default-deny: a host that never says `true` gets no `show_*` tools,
   * which is correct for a gateway with no visual surface to render into.
   */
  visualTools?: boolean;
  /** Capability minted by the calling adapter. Default-deny, like `visualTools`. */
  fileDeliveryTools?: boolean;
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
        // Whether the message ran the AI is part of the turn's identity, not a
        // presentation detail: replaying the same key with `respond` flipped
        // would otherwise reuse the silent ACK and never queue the turn (or
        // vice versa), with nothing to tell the caller it was ignored.
        params.respond ?? true,
        // Part of the identity of the turn: the same key asked in the channel
        // and in a thread are different turns, and replaying one as the other
        // would answer in the wrong place.
        params.threadRootId ?? null,
        params.attachments ?? [],
        // `visualTools`/`fileDeliveryTools` are deliberately absent. They are a
        // property of the calling adapter, not of the message, so they are the
        // same for every turn a given host sends. Hashing them would only turn
        // an adapter upgrade into a 409 for keys that were already in flight.
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
  const respond = params.respond ?? true;
  const payloadHash = gatewayPayloadHash(params, requestId, actorUserId);
  const existing = findRuntimeGatewaySubmission(params.clientMessageId, requestId);
  if (existing) {
    return duplicateResult(existing, params, requestId, actorUserId, payloadHash);
  }

  // Remember what this adapter grants for the room, so the turns that never
  // see an adapter — tell/ask, cron, auto-continue, subagent reports — inherit
  // it instead of silently running without the tools.
  recordTopicToolCapabilities(params.topic.id, {
    visualTools: params.visualTools === true,
    fileDeliveryTools: params.fileDeliveryTools === true,
  });

  const createdAt = new Date().toISOString();
  const attachments = params.attachments?.map(resolveAttachmentByFileId);
  if (attachments?.some((attachment) => !attachment)) {
    throw new Error("gateway attachment could not be resolved");
  }
  const message: MessageDto = {
    id: randomUUID(),
    topicId: params.topic.id,
    authorId: actorUserId,
    authorName: params.actorLabel,
    sourceAdapter: "runtime-gateway",
    sourceMessageId: params.clientMessageId,
    text: params.text,
    ...(attachments?.length
      ? { attachments: attachments as NonNullable<MessageDto["attachments"]> }
      : {}),
    ...(params.threadRootId ? { threadRootId: params.threadRootId } : {}),
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
      // The only thing `respond: false` skips. Everything else — the canonical
      // message, the accepted event, the idempotency record — still happens, so
      // a silent message is indistinguishable from a normal one everywhere
      // except that no turn is queued for it.
      if (respond) {
        mergeRuntimeUserTurnRequest({
          topicId: params.topic.id,
          userId: params.userId,
          userMessages: [
            {
              prompt: params.text,
              actorUserId,
              ...(params.actorLabel ? { actorLabel: params.actorLabel } : {}),
              ...(params.attachments?.length ? { attachments: params.attachments } : {}),
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
            actorUserId,
            // The adapter's capability grant has to ride the durable request:
            // the turn worker builds the runtime MCP from `execution`, so a
            // flag left here undefined is what makes `show_html` and friends
            // absent from a mapped room's turn.
            visualTools: params.visualTools,
            fileDeliveryTools: params.fileDeliveryTools,
            ...(params.threadRootId ? { threadRootId: params.threadRootId } : {}),
          },
        });
      }
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
  //
  // That resume is the whole reason the abort is safe, so it is conditional on
  // the merge: with `respond: false` there is no replacement batch, and
  // aborting would kill a running answer with nothing left to resume it.
  if (respond) requestRuntimeTurnAbort(params.topic.id, "internal");

  return { ...submission, message, deduplicated: false };
}
