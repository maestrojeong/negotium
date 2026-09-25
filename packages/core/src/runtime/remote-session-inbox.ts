/**
 * What the hub delivers into this node for remote session-comm
 * (`POST /topics/:nodeTopicId/session-comm/inbox`): a tell, an ask (with the
 * hub's reply route), an abort, or the answer to an ask this node's room
 * raised. Parsing and the idempotent hand-off to the durable session inbox
 * live here so the gateway route in `control.ts` only does transport.
 */
import { MAX_PEER_MESSAGE_LENGTH } from "#mcp/session-comm/limits";
import { type HubRemoteReplyRoute, parseHubRemoteReplyRoute } from "#mcp/session-comm/peer-forward";
import { MAX_TELL_DEPTH } from "#platform/config";
import { logger } from "#platform/logger";
import { db } from "#storage/forum-db";
import {
  claimRemoteSessionInbox,
  completeRemoteSessionInboxClaim,
  deleteRemoteSessionAsk,
  getRemoteSessionAsk,
  listExpiredRemoteSessionInboxClaims,
  type RemoteSessionAskRecord,
  releaseRemoteSessionInboxClaim,
  remoteSessionPayloadHash,
} from "#storage/remote-session";
import { enqueueSessionInbox } from "#storage/session-inbox";
import type { TopicDto } from "#types/api";

export const MAX_REMOTE_SESSION_REQUEST_ID_LENGTH = 200;
export const MAX_REMOTE_SESSION_LABEL_LENGTH = 300;

export interface RemoteSessionInboxFrom {
  /** "<originNode>/<originTitle>", shown to the target as the sender. */
  label: string;
  /** The hub's own id of the origin room, for the hub's audit trail; opaque here. */
  hubTopicId?: string;
}

export type RemoteSessionInboxDelivery =
  | {
      kind: "tell";
      requestId: string;
      from: RemoteSessionInboxFrom;
      message: string;
      depth: number;
    }
  | {
      kind: "ask";
      requestId: string;
      from: RemoteSessionInboxFrom;
      message: string;
      fromDepth: number;
      remoteReply: HubRemoteReplyRoute;
    }
  | { kind: "abort"; requestId: string }
  | {
      kind: "ask-reply";
      requestId: string;
      fromLabel: string;
      replyKind: "reply" | "error";
      replyText: string;
    };

/** A malformed delivery, answered with its status (400 or 413). */
export class RemoteSessionInboxError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteSessionInboxError";
  }
}

function text(value: unknown, name: string, max?: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RemoteSessionInboxError(400, `${name} is required`);
  }
  const trimmed = value.trim();
  if (max !== undefined && trimmed.length > max) {
    throw new RemoteSessionInboxError(400, `${name} is longer than ${max} characters`);
  }
  return trimmed;
}

function message(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RemoteSessionInboxError(400, "message is required");
  }
  if (value.length > MAX_PEER_MESSAGE_LENGTH) {
    throw new RemoteSessionInboxError(
      413,
      `message is ${value.length} characters; at most ${MAX_PEER_MESSAGE_LENGTH} are allowed`,
    );
  }
  return value;
}

function depth(value: unknown, name: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RemoteSessionInboxError(400, `${name} must be a non-negative integer`);
  }
  if ((value as number) > max) {
    throw new RemoteSessionInboxError(400, `${name} exceeds the tell depth limit (${max})`);
  }
  return value as number;
}

function from(value: unknown): RemoteSessionInboxFrom {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteSessionInboxError(400, "from must be { label, hubTopicId? }");
  }
  const record = value as Record<string, unknown>;
  const label = text(record.label, "from.label", MAX_REMOTE_SESSION_LABEL_LENGTH);
  if (record.hubTopicId !== undefined && typeof record.hubTopicId !== "string") {
    throw new RemoteSessionInboxError(400, "from.hubTopicId must be a string");
  }
  return { label, ...(record.hubTopicId ? { hubTopicId: record.hubTopicId } : {}) };
}

/** Validate a delivery body; throws {@link RemoteSessionInboxError}. */
export function parseRemoteSessionInboxDelivery(
  body: Record<string, unknown>,
): RemoteSessionInboxDelivery {
  const kind = text(body.kind, "kind");
  const requestId = text(body.requestId, "requestId", MAX_REMOTE_SESSION_REQUEST_ID_LENGTH);
  switch (kind) {
    case "tell":
      return {
        kind,
        requestId,
        from: from(body.from),
        message: message(body.message),
        // The hub sends the depth the target runs at (caller + 1), already
        // checked there; checked again here so a node is never made to run
        // deeper than its own limit.
        depth: depth(body.depth, "depth", MAX_TELL_DEPTH),
      };
    case "ask": {
      const remoteReply = parseHubRemoteReplyRoute(body.remoteReply);
      if (!remoteReply) {
        throw new RemoteSessionInboxError(
          400,
          "remoteReply must be { via: 'hub', hubUrl, token, nodeName, topicId, requestId }",
        );
      }
      if (remoteReply.requestId !== requestId) {
        throw new RemoteSessionInboxError(400, "remoteReply.requestId must equal requestId");
      }
      return {
        kind,
        requestId,
        from: from(body.from),
        message: message(body.message),
        // The caller's own depth; the fork answering it runs one deeper.
        fromDepth: depth(body.fromDepth, "fromDepth", MAX_TELL_DEPTH),
        remoteReply,
      };
    }
    case "abort":
      return { kind, requestId };
    case "ask-reply": {
      const replyKind = text(body.replyKind, "replyKind");
      if (replyKind !== "reply" && replyKind !== "error") {
        throw new RemoteSessionInboxError(400, "replyKind must be 'reply' or 'error'");
      }
      if (typeof body.replyText !== "string") {
        throw new RemoteSessionInboxError(400, "replyText is required");
      }
      return {
        kind,
        requestId,
        fromLabel: text(body.fromLabel, "fromLabel", MAX_REMOTE_SESSION_LABEL_LENGTH),
        replyKind,
        replyText: body.replyText,
      };
    }
    default:
      throw new RemoteSessionInboxError(400, "kind must be one of tell, ask, abort, ask-reply");
  }
}

export type RemoteSessionInboxOutcome =
  | { ok: true; replayed: boolean }
  | { ok: false; status: number; error: string; code?: string };

/** Answer for a duplicate that meets a live `processing` claim: come back later. */
export const REMOTE_SESSION_INBOX_IN_PROGRESS_CODE = "in_progress";

/**
 * One delivery at a time per `requestId` inside this process. The durable
 * lease guards across processes; this guards the async window between the
 * claim and its completion within one, so two identical ask-replies arriving
 * together run strictly one after the other (the second then sees either a
 * `completed` claim, a released one, or the ask consumed).
 */
const inboxLocks = new Map<string, Promise<unknown>>();

async function withRequestLock<T>(requestId: string, run: () => Promise<T>): Promise<T> {
  const previous = inboxLocks.get(requestId) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  inboxLocks.set(requestId, settled);
  try {
    return await current;
  } finally {
    if (inboxLocks.get(requestId) === settled) inboxLocks.delete(requestId);
  }
}

/**
 * Hand one hub delivery to the durable session inbox exactly once.
 *
 * The claim and the enqueue share a transaction: a retried delivery with the
 * same payload is acknowledged as a replay without a second entry, the same
 * `requestId` with a different payload is a conflict, and a failed enqueue
 * leaves no claim behind so the hub's retry is accepted. `ask-reply` is the
 * caller side: the row `recordRemoteSessionAsk` wrote when the ask went out
 * says which room (and thread) the answer belongs in.
 */
export async function deliverRemoteSessionInbox(args: {
  topic: Pick<TopicDto, "id" | "title" | "agent">;
  /** Execution principal the inbox entry is queued under (a participant). */
  userId: string;
  delivery: RemoteSessionInboxDelivery;
}): Promise<RemoteSessionInboxOutcome> {
  const { topic, userId, delivery } = args;
  const payloadHash = remoteSessionPayloadHash(delivery);
  const timestamp = new Date().toISOString();

  if (delivery.kind === "tell" || delivery.kind === "ask") {
    // The hub already judged "has AI" from its mirror; the node's own row is
    // final (the two can disagree for a moment after a config change).
    if (!topic.agent) {
      return { ok: false, status: 409, error: `Session "${topic.title}" has no AI invited.` };
    }
  }

  if (delivery.kind === "ask-reply") {
    return withRequestLock(delivery.requestId, () =>
      deliverAskReply({ topic, delivery, payloadHash }),
    );
  }

  const entry =
    delivery.kind === "tell"
      ? {
          type: "tell" as const,
          requestId: delivery.requestId,
          from: delivery.from.label,
          fromTitle: delivery.from.label,
          message: delivery.message,
          depth: delivery.depth,
          timestamp,
        }
      : delivery.kind === "ask"
        ? {
            type: "ask" as const,
            requestId: delivery.requestId,
            from: delivery.from.label,
            fromTitle: delivery.from.label,
            message: delivery.message,
            fromDepth: delivery.fromDepth,
            remoteReply: delivery.remoteReply,
            timestamp,
          }
        : { type: "abort" as const, timestamp };

  const outcome = db.transaction((): RemoteSessionInboxOutcome => {
    const claim = claimRemoteSessionInbox({
      requestId: delivery.requestId,
      kind: delivery.kind,
      topicId: topic.id,
      payloadHash,
    });
    if (claim === "replay") return { ok: true, replayed: true };
    if (claim === "conflict") {
      return { ok: false, status: 409, error: "requestId is already bound to another delivery" };
    }
    if (claim === "in_progress") {
      // Cannot happen for a synchronous claim+enqueue, but the state machine
      // is uniform: a live lease is never answered as a replay.
      return {
        ok: false,
        status: 409,
        error: "this delivery is still being processed; retry shortly",
        code: REMOTE_SESSION_INBOX_IN_PROGRESS_CODE,
      };
    }
    enqueueSessionInbox({ userId, topicId: topic.id, entry });
    // Same transaction as the enqueue: the claim is `completed` exactly when
    // the entry is durable, never before.
    completeRemoteSessionInboxClaim(delivery.requestId);
    return { ok: true, replayed: false };
  })();
  if (outcome.ok && !outcome.replayed) {
    logger.info(
      { topicId: topic.id, kind: delivery.kind, requestId: delivery.requestId },
      "session-comm: remote delivery queued",
    );
  }
  return outcome;
}

type AskReplyDelivery = Extract<RemoteSessionInboxDelivery, { kind: "ask-reply" }>;

/**
 * The caller side of a remote ask, as one durable state machine:
 *
 *   claim `processing` (payload persisted) → deliver into the caller room →
 *   [same transaction] record written + ask row consumed + claim `completed`.
 *
 * Nothing is deleted before the answer is durably in the room, so a crash at
 * any step leaves either a `processing` claim (re-run by
 * {@link recoverRemoteSessionInbox} once its lease expires, the ask row still
 * there) or a `completed` one (a replay). A duplicate that meets a live lease
 * is told `in_progress` (409) — never a false replay — and a delivery that
 * fails releases the claim so the hub's retry runs it again.
 */
async function deliverAskReply(args: {
  topic: Pick<TopicDto, "id" | "title" | "agent">;
  delivery: AskReplyDelivery;
  payloadHash: string;
  now?: number;
}): Promise<RemoteSessionInboxOutcome> {
  const { topic, delivery, payloadHash } = args;
  const claim = claimRemoteSessionInbox({
    requestId: delivery.requestId,
    kind: delivery.kind,
    topicId: topic.id,
    payloadHash,
    payload: delivery,
    now: args.now,
  });
  if (claim === "replay") return { ok: true, replayed: true };
  if (claim === "conflict") {
    return { ok: false, status: 409, error: "requestId is already bound to another delivery" };
  }
  if (claim === "in_progress") {
    return {
      ok: false,
      status: 409,
      error: "this reply is still being delivered; retry shortly",
      code: REMOTE_SESSION_INBOX_IN_PROGRESS_CODE,
    };
  }
  const ask = getRemoteSessionAsk(delivery.requestId);
  if (!ask || ask.callerTopicId !== topic.id) {
    releaseRemoteSessionInboxClaim(delivery.requestId);
    return { ok: false, status: 404, error: "no pending remote ask with this requestId" };
  }
  return runAskReplyDelivery(ask, delivery);
}

type AskReplyDeliverer = typeof import("#runtime/turn-runner").deliverAskCallbackToCaller;

let askReplyDeliverer: AskReplyDeliverer | null = null;

/** Test seam: replace the caller-room injection (to fail it, or to observe it). */
export function setRemoteSessionAskReplyDeliverer(next: AskReplyDeliverer | null): void {
  askReplyDeliverer = next;
}

/** Deliver and, in the same transaction as the room record, consume + complete. */
async function runAskReplyDelivery(
  ask: RemoteSessionAskRecord,
  delivery: AskReplyDelivery,
): Promise<RemoteSessionInboxOutcome> {
  const deliverAskCallbackToCaller =
    askReplyDeliverer ?? (await import("#runtime/turn-runner")).deliverAskCallbackToCaller;
  let delivered = false;
  let recorded = false;
  const onRecorded = () => {
    deleteRemoteSessionAsk(ask.requestId);
    completeRemoteSessionInboxClaim(ask.requestId);
    recorded = true;
  };
  try {
    delivered = await deliverAskCallbackToCaller(
      {
        requestId: ask.requestId,
        callerTopicId: ask.callerTopicId,
        ...(ask.callerThreadRootId ? { callerThreadRootId: ask.callerThreadRootId } : {}),
        callerUserId: ask.userId,
        pendingAsk: {
          userId: ask.userId,
          from: ask.fromKey,
          to: ask.toKey,
          requestId: ask.requestId,
        },
      },
      delivery.fromLabel,
      delivery.replyText,
      delivery.replyKind,
      { onRecorded },
    );
  } catch (err) {
    logger.warn(
      { err, requestId: ask.requestId, callerTopicId: ask.callerTopicId },
      "session-comm: remote ask reply delivery threw",
    );
  }
  if (!delivered || !recorded) {
    // Nothing durable happened in the caller room: hand the claim back so the
    // hub's retry (or the recovery pass) runs the delivery again.
    releaseRemoteSessionInboxClaim(ask.requestId);
    return { ok: false, status: 500, error: "reply could not be delivered to the caller" };
  }
  return { ok: true, replayed: false };
}

/**
 * Re-run deliveries a previous process (or a hung one) left `processing`
 * past their lease. Called from the periodic maintenance pass, and at startup
 * with `includeLive` (a fresh process knows no lease is really held). An ask-reply whose ask row is gone can only be a completed delivery
 * whose completion did not persist (impossible by construction, but cheap to
 * tolerate): it is completed. Claims of the other kinds complete in the same
 * transaction as their enqueue, so an expired `processing` one is a claim
 * whose enqueue never happened — released, so the hub's retry is accepted.
 */
export async function recoverRemoteSessionInbox(
  now: number = Date.now(),
  options: { includeLive?: boolean } = {},
): Promise<number> {
  let recovered = 0;
  for (const claim of listExpiredRemoteSessionInboxClaims(now, options)) {
    if (claim.kind !== "ask-reply") {
      releaseRemoteSessionInboxClaim(claim.requestId);
      continue;
    }
    let delivery: AskReplyDelivery | null = null;
    try {
      const parsed = parseRemoteSessionInboxDelivery(
        (claim.payload ?? {}) as Record<string, unknown>,
      );
      if (parsed.kind === "ask-reply") delivery = parsed;
    } catch {
      delivery = null;
    }
    if (!delivery) {
      logger.warn(
        { requestId: claim.requestId },
        "session-comm: interrupted remote ask reply has no readable payload; releasing",
      );
      releaseRemoteSessionInboxClaim(claim.requestId);
      continue;
    }
    const outcome = await withRequestLock(claim.requestId, async () => {
      // Re-take the lease under the lock; a concurrent hub retry may have
      // beaten us to it.
      const retaken = claimRemoteSessionInbox({
        requestId: claim.requestId,
        kind: claim.kind,
        topicId: claim.topicId,
        payloadHash: claim.payloadHash,
        payload: delivery,
        now,
        force: options.includeLive === true,
      });
      if (retaken !== "claimed") return retaken;
      const ask = getRemoteSessionAsk(claim.requestId);
      if (!ask) {
        completeRemoteSessionInboxClaim(claim.requestId);
        return "completed-orphan";
      }
      const result = await runAskReplyDelivery(ask, delivery);
      return result.ok ? "delivered" : "failed";
    });
    if (outcome === "delivered") recovered += 1;
    logger.info(
      { requestId: claim.requestId, outcome },
      "session-comm: recovered interrupted remote ask reply",
    );
  }
  return recovered;
}
