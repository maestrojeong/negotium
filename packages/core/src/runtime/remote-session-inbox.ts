/**
 * What the hub delivers into this node for remote session-comm
 * (`POST /topics/:nodeTopicId/session-comm/inbox`): a tell, an ask (with the
 * hub's reply route), an abort, or the answer to an ask this node's room
 * raised. Parsing and the idempotent hand-off to the durable session inbox
 * live here so the gateway route in `control.ts` only does transport.
 */
import { type DeliveryParticipant, localDeliveryPrincipal } from "#mcp/session-comm/actor-policy";
import { MAX_PEER_MESSAGE_LENGTH } from "#mcp/session-comm/limits";
import { type HubRemoteReplyRoute, parseHubRemoteReplyRoute } from "#mcp/session-comm/peer-forward";
import { MAX_TELL_DEPTH } from "#platform/config";
import { logger } from "#platform/logger";
import { getTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import {
  claimRemoteSessionInbox,
  completeRemoteSessionInboxClaim,
  deleteExpiredRemoteSessionAsk,
  deleteRemoteSessionAsk,
  getRemoteSessionAsk,
  getRemoteSessionInboxClaim,
  listExpiredRemoteSessionInboxClaims,
  listRemoteSessionAsksToExpire,
  markRemoteSessionAskExpired,
  type RemoteSessionAskRecord,
  type RemoteSessionInboxClaimRecord,
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
 * The hub asserts, in `actorUserId`, the execution principal of the person
 * whose remote capability sent this delivery. The node files the inbox entry
 * — and so runs the target's turn, with that principal's vault, browser
 * profile and tool grants — only under that same principal: `userId` must
 * equal `actorUserId`, and that principal must be a participant of the room.
 * This is the remote twin of `localDeliveryPrincipal` (a session can never
 * make a room run as someone else), and it holds even if the hub resolves
 * `userId` to the room's owner instead of the actor (the confused deputy).
 */
export const REMOTE_SESSION_REQUIRE_ACTOR_ENV = "NEGOTIUM_REMOTE_SESSION_REQUIRE_ACTOR";
/** 403: `actorUserId` absent while {@link REMOTE_SESSION_REQUIRE_ACTOR_ENV} is on. */
export const REMOTE_SESSION_ACTOR_REQUIRED_CODE = "actor_required";
/** 403: `actorUserId` differs from `userId` (or, for `ask-reply`, from the asker). */
export const REMOTE_SESSION_ACTOR_MISMATCH_CODE = "actor_mismatch";
/** 403: the asserted actor is not a participant of the target room. */
export const REMOTE_SESSION_ACTOR_NOT_PARTICIPANT_CODE = "actor_not_participant";

/**
 * Whether a delivery without `actorUserId` (a hub older than this contract)
 * is refused. Off by default so an upgraded node keeps working behind an old
 * hub; turn it on once every hub that reaches this node sends the field.
 * Read per request, so flipping it needs no restart of the route's state.
 */
export function remoteSessionRequireActor(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[REMOTE_SESSION_REQUIRE_ACTOR_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export type RemoteSessionPrincipalOutcome =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Decide the principal a remote delivery is filed under, before anything is
 * claimed or queued. `actorUserId: undefined` is the pre-contract hub: it is
 * refused when `requireActor`, else it keeps the old rule (`userId` must be a
 * participant; 404 otherwise, as before).
 */
export function resolveRemoteSessionInboxPrincipal(input: {
  userId: string;
  actorUserId: string | undefined;
  targetParticipants: readonly DeliveryParticipant[] | undefined;
  requireActor?: boolean;
}): RemoteSessionPrincipalOutcome {
  const { userId, actorUserId, targetParticipants } = input;
  const requireActor = input.requireActor ?? remoteSessionRequireActor();
  if (actorUserId === undefined) {
    if (requireActor) {
      return {
        ok: false,
        status: 403,
        error: "actorUserId is required: this node only accepts actor-bound remote deliveries",
        code: REMOTE_SESSION_ACTOR_REQUIRED_CODE,
      };
    }
    if (!(targetParticipants ?? []).some((participant) => participant.userId === userId)) {
      return { ok: false, status: 404, error: "Topic not found" };
    }
    return { ok: true, userId };
  }
  if (actorUserId !== userId) {
    return {
      ok: false,
      status: 403,
      error:
        "actorUserId must equal userId: a remote session can only run a room as its own principal",
      code: REMOTE_SESSION_ACTOR_MISMATCH_CODE,
    };
  }
  const principal = localDeliveryPrincipal({ callerUserId: actorUserId, targetParticipants });
  if (principal === null) {
    return {
      ok: false,
      status: 403,
      error: "actorUserId is not a participant of the target room",
      code: REMOTE_SESSION_ACTOR_NOT_PARTICIPANT_CODE,
    };
  }
  return { ok: true, userId: principal };
}

/**
 * The identity a claim binds a `requestId` to: the delivery *and* the
 * principal it was accepted under. Hashing the principal too means the same
 * `requestId` replayed by another actor (or filed under another `userId`) is
 * a `conflict`, never a `replay` of somebody else's delivery. Key order is
 * fixed here, so the digest is stable.
 */
export interface RemoteSessionInboxClaimIdentity {
  userId: string;
  /** `null`: accepted from a hub older than the actor contract (legacy rule). */
  actorUserId: string | null;
  delivery: RemoteSessionInboxDelivery;
}

export function remoteSessionInboxClaimHash(identity: {
  userId: string;
  actorUserId?: string | null;
  delivery: RemoteSessionInboxDelivery;
}): string {
  return remoteSessionPayloadHash({
    userId: identity.userId,
    actorUserId: identity.actorUserId ?? null,
    delivery: identity.delivery,
  });
}

/** Version tag of {@link RemoteSessionInboxEnvelope}; a payload without it is legacy. */
export const REMOTE_SESSION_INBOX_ENVELOPE_VERSION = 2;

/**
 * What a `processing` claim persists (`payload_json`) so an interrupted
 * delivery can be re-run: the delivery plus the principal it was verified
 * under, and — for `ask-reply` — the principal of the pending ask it was
 * verified against (`askUserId`). Recovery re-verifies all of it against the
 * current ask row and room before delivering; a payload without this envelope
 * (written by a node before the actor-bound claim) is never delivered.
 */
export interface RemoteSessionInboxEnvelope extends RemoteSessionInboxClaimIdentity {
  v: typeof REMOTE_SESSION_INBOX_ENVELOPE_VERSION;
  askUserId?: string;
}

export function remoteSessionInboxEnvelope(input: {
  userId: string;
  actorUserId?: string | null;
  delivery: RemoteSessionInboxDelivery;
  askUserId?: string;
}): RemoteSessionInboxEnvelope {
  return {
    v: REMOTE_SESSION_INBOX_ENVELOPE_VERSION,
    userId: input.userId,
    actorUserId: input.actorUserId ?? null,
    delivery: input.delivery,
    ...(input.askUserId !== undefined ? { askUserId: input.askUserId } : {}),
  };
}

/** A persisted envelope, or `null` for a legacy / unreadable / malformed one. */
function readRemoteSessionInboxEnvelope(payload: unknown): RemoteSessionInboxEnvelope | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.v !== REMOTE_SESSION_INBOX_ENVELOPE_VERSION) return null;
  if (typeof record.userId !== "string" || !record.userId) return null;
  if (
    record.actorUserId !== null &&
    (typeof record.actorUserId !== "string" || !record.actorUserId)
  ) {
    return null;
  }
  if (
    record.askUserId !== undefined &&
    (typeof record.askUserId !== "string" || !record.askUserId)
  ) {
    return null;
  }
  if (!record.delivery || typeof record.delivery !== "object") return null;
  let delivery: RemoteSessionInboxDelivery;
  try {
    delivery = parseRemoteSessionInboxDelivery(record.delivery as Record<string, unknown>);
  } catch {
    return null;
  }
  return remoteSessionInboxEnvelope({
    userId: record.userId,
    actorUserId: record.actorUserId as string | null,
    delivery,
    ...(typeof record.askUserId === "string" ? { askUserId: record.askUserId } : {}),
  });
}

/**
 * Whether a pending ask may be answered by a delivery accepted under
 * `userId`/`actorUserId`: it must belong to this room and, when the hub
 * asserted an actor, to exactly that principal (`actorUserId === userId ===
 * ask.userId`). Without an actor (old hub) the legacy rule stands: the route
 * already required `userId` to be a participant.
 */
function askReplyPrincipalRefusal(input: {
  ask: RemoteSessionAskRecord;
  topicId: string;
  userId: string;
  actorUserId: string | null;
}): Extract<RemoteSessionInboxOutcome, { ok: false }> | null {
  const { ask, topicId, userId, actorUserId } = input;
  if (ask.callerTopicId !== topicId) {
    return { ok: false, status: 404, error: "no pending remote ask with this requestId" };
  }
  if (actorUserId !== null && (actorUserId !== userId || ask.userId !== actorUserId)) {
    // The answer goes into the room of the principal that asked; a delivery
    // asserted for anyone else is not that answer.
    return {
      ok: false,
      status: 403,
      error: "actorUserId is not the principal that raised this ask",
      code: REMOTE_SESSION_ACTOR_MISMATCH_CODE,
    };
  }
  return null;
}

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
  /**
   * The hub-asserted actor ({@link resolveRemoteSessionInboxPrincipal}).
   * When present it must equal `userId` — re-checked here so no caller of
   * this function can queue an entry under a principal other than the actor —
   * and an `ask-reply` must answer an ask that principal raised.
   */
  actorUserId?: string;
  delivery: RemoteSessionInboxDelivery;
}): Promise<RemoteSessionInboxOutcome> {
  const { topic, userId, actorUserId, delivery } = args;
  if (actorUserId !== undefined && actorUserId !== userId) {
    return {
      ok: false,
      status: 403,
      error:
        "actorUserId must equal userId: a remote session can only run a room as its own principal",
      code: REMOTE_SESSION_ACTOR_MISMATCH_CODE,
    };
  }
  // Bound to the principal too: the same requestId under another actor is a
  // conflict. `legacyPayloadHash` is what a node before this contract stored.
  const payloadHash = remoteSessionInboxClaimHash({ userId, actorUserId, delivery });
  const legacyPayloadHash = remoteSessionPayloadHash(delivery);
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
      deliverAskReply({ topic, delivery, payloadHash, legacyPayloadHash, userId, actorUserId }),
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
      legacyPayloadHash,
      // Uniform envelope for every kind; completed in this same transaction
      // (which clears it), so recovery only ever sees it for an enqueue that
      // never happened — and releases it without running anything.
      payload: remoteSessionInboxEnvelope({ userId, actorUserId, delivery }),
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
 *   verify (pending ask + principal) → claim `processing` (verified envelope
 *   persisted) → deliver into the caller room → [same transaction] record
 *   written + ask row consumed + claim `completed`.
 *
 * The principal is checked *before* anything is persisted, and the persisted
 * envelope carries the principal it was checked under, so a crash at any step
 * leaves either nothing, a `processing` claim that {@link
 * recoverRemoteSessionInbox} re-verifies against the ask row before re-running
 * it, or a `completed` one (a replay). Nothing is deleted before the answer is
 * durably in the room. A duplicate that meets a live lease is told
 * `in_progress` (409) — never a false replay — and a delivery that fails
 * releases the claim so the hub's retry runs it again.
 */
async function deliverAskReply(args: {
  topic: Pick<TopicDto, "id" | "title" | "agent">;
  delivery: AskReplyDelivery;
  payloadHash: string;
  legacyPayloadHash: string;
  userId: string;
  actorUserId?: string;
  now?: number;
}): Promise<RemoteSessionInboxOutcome> {
  const { topic, delivery, payloadHash, legacyPayloadHash, userId } = args;
  const actorUserId = args.actorUserId ?? null;
  const ask = getRemoteSessionAsk(delivery.requestId);
  if (!ask) {
    // Nothing is waiting: a retry of a reply that already landed is a replay,
    // anything else a 404/409. Read-only — no claim is written for a delivery
    // that has nothing to answer.
    return answerWithoutPendingAsk({ topic, delivery, payloadHash, legacyPayloadHash });
  }
  const refusal = askReplyPrincipalRefusal({ ask, topicId: topic.id, userId, actorUserId });
  if (refusal) return refusal;
  const claim = claimRemoteSessionInbox({
    requestId: delivery.requestId,
    kind: delivery.kind,
    topicId: topic.id,
    payloadHash,
    legacyPayloadHash,
    payload: remoteSessionInboxEnvelope({ userId, actorUserId, delivery, askUserId: ask.userId }),
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
  // Under the claim now: re-read the ask so the delivery answers the row the
  // lease protects, and re-check it (it cannot have changed hands, but the
  // check is what the envelope promises).
  const held = getRemoteSessionAsk(delivery.requestId);
  const heldRefusal = held
    ? askReplyPrincipalRefusal({ ask: held, topicId: topic.id, userId, actorUserId })
    : { ok: false as const, status: 404, error: "no pending remote ask with this requestId" };
  if (!held || heldRefusal || held.userId !== ask.userId) {
    releaseRemoteSessionInboxClaim(delivery.requestId, { payloadHash });
    return (
      heldRefusal ?? { ok: false, status: 404, error: "no pending remote ask with this requestId" }
    );
  }
  return runAskReplyDelivery(held, delivery, payloadHash);
}

/** An ask-reply for which no ask is pending: replay, conflict, in-progress or 404 — never a write. */
function answerWithoutPendingAsk(args: {
  topic: Pick<TopicDto, "id">;
  delivery: AskReplyDelivery;
  payloadHash: string;
  legacyPayloadHash: string;
}): RemoteSessionInboxOutcome {
  const existing = getRemoteSessionInboxClaim(args.delivery.requestId);
  if (existing) {
    const same =
      existing.kind === args.delivery.kind &&
      existing.topicId === args.topic.id &&
      (existing.payloadHash === args.payloadHash ||
        existing.payloadHash === args.legacyPayloadHash);
    if (!same) {
      return { ok: false, status: 409, error: "requestId is already bound to another delivery" };
    }
    if (existing.state === "completed") return { ok: true, replayed: true };
    return {
      ok: false,
      status: 409,
      error: "this reply is still being delivered; retry shortly",
      code: REMOTE_SESSION_INBOX_IN_PROGRESS_CODE,
    };
  }
  return { ok: false, status: 404, error: "no pending remote ask with this requestId" };
}

type AskReplyDeliverer = typeof import("#runtime/turn-runner").deliverAskCallbackToCaller;

let askReplyDeliverer: AskReplyDeliverer | null = null;

/** Test seam: replace the caller-room injection (to fail it, or to observe it). */
export function setRemoteSessionAskReplyDeliverer(next: AskReplyDeliverer | null): void {
  askReplyDeliverer = next;
}

/**
 * Deliver and, in the same transaction as the room record, consume + complete.
 * `claimHash` is the digest of the `processing` claim the caller holds (under
 * the request lock); a failed delivery releases only that claim.
 */
async function runAskReplyDelivery(
  ask: RemoteSessionAskRecord,
  delivery: AskReplyDelivery,
  claimHash: string,
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
    // Nothing durable happened in the caller room (or the recording
    // transaction rolled back): hand the claim back so the hub's retry (or the
    // recovery pass) runs the delivery again. A compare-and-delete: if the
    // answer did become durable, the claim is `completed` and survives, so the
    // retry after this 500 is a replay rather than a 404.
    releaseRemoteSessionInboxClaim(ask.requestId, { payloadHash: claimHash });
    return { ok: false, status: 500, error: "reply could not be delivered to the caller" };
  }
  return { ok: true, replayed: false };
}

/** The caller-facing text for an outbound ask whose fate nobody learned. */
export function remoteSessionAskNoReplyText(
  ask: Pick<RemoteSessionAskRecord, "toKey" | "requestId">,
): string {
  return [
    `No reply arrived for the ask to "${ask.toKey}" (request_id: ${ask.requestId}).`,
    "This node was interrupted (restart or lost connection) before the hub confirmed the ask was delivered, and nothing came back within the ask timeout.",
    "It may never have reached the target. Ask again if you still need an answer.",
  ].join(" ");
}

/**
 * Tell callers that an outbound hub ask in the `unknown` state (the hub's
 * receipt was never confirmed) timed out without a reply. Each ask is moved
 * `unknown` → `expired` first — refused while a late reply holds an inbox
 * claim for it, and from then on invisible to the reply path — and the row
 * is removed in the same transaction that records the notice. A notice that
 * could not be recorded stays `expired` and is retried on the next pass.
 * Idempotent; runs in the maintenance pass. Returns how many notices landed.
 */
export async function expireUnknownRemoteSessionAsks(now: number = Date.now()): Promise<number> {
  const due = listRemoteSessionAsksToExpire(now);
  if (!due.length) return 0;
  const deliverAskCallbackToCaller =
    askReplyDeliverer ?? (await import("#runtime/turn-runner")).deliverAskCallbackToCaller;
  let notified = 0;
  for (const ask of due) {
    await withRequestLock(ask.requestId, async () => {
      if (ask.dispatchState === "unknown" && !markRemoteSessionAskExpired(ask.requestId)) return;
      let recorded = false;
      try {
        await deliverAskCallbackToCaller(
          {
            requestId: ask.requestId,
            callerTopicId: ask.callerTopicId,
            ...(ask.callerThreadRootId ? { callerThreadRootId: ask.callerThreadRootId } : {}),
            callerUserId: ask.userId,
          },
          ask.toKey,
          remoteSessionAskNoReplyText(ask),
          "error",
          {
            onRecorded: () => {
              deleteExpiredRemoteSessionAsk(ask.requestId);
              recorded = true;
            },
          },
        );
      } catch (err) {
        logger.warn(
          { err, requestId: ask.requestId, callerTopicId: ask.callerTopicId },
          "session-comm: remote ask no-reply notice threw",
        );
      }
      if (recorded) notified += 1;
    });
  }
  return notified;
}

/**
 * Why a recovered ask-reply envelope may not be delivered now, or `null`.
 * Everything the live path checked is checked again against the *current*
 * state: the ask row (room, and the principal it was verified against), the
 * actor rule (`actorUserId === userId === ask.userId`), that principal still
 * being a participant of the room, and — for an envelope accepted from an old
 * hub (`actorUserId: null`) — that the node still accepts such deliveries.
 */
function recoveredAskReplyRefusal(
  envelope: RemoteSessionInboxEnvelope,
  ask: RemoteSessionAskRecord,
  topicId: string,
  requireActor: boolean,
): string | null {
  if (envelope.askUserId === undefined || envelope.askUserId !== ask.userId) {
    return "the envelope was not verified against this ask";
  }
  if (envelope.actorUserId === null && requireActor) {
    return "actor-less delivery while actorUserId is required";
  }
  const refusal = askReplyPrincipalRefusal({
    ask,
    topicId,
    userId: envelope.userId,
    actorUserId: envelope.actorUserId,
  });
  if (refusal) return refusal.error;
  const room = getTopic(topicId);
  if (
    !room ||
    localDeliveryPrincipal({
      callerUserId: envelope.userId,
      targetParticipants: room.participants,
    }) === null
  ) {
    return "the principal is not a participant of the caller room";
  }
  return null;
}

/**
 * Re-run deliveries a previous process (or a hung one) left `processing`
 * past their lease. Called from the periodic maintenance pass, and at startup
 * with `includeLive` (a fresh process knows no lease is really held).
 *
 * Only an `ask-reply` is ever re-run, and only from a verified envelope
 * ({@link RemoteSessionInboxEnvelope}) whose digest matches the claim and
 * which re-verifies against the current ask row and room
 * ({@link recoveredAskReplyRefusal}); anything else — a legacy payload
 * without the principal, an unreadable one, a refused one — is dropped (the
 * claim released, the ask row untouched, nothing delivered), so the hub's
 * retry goes through every live check again. An ask-reply whose ask row is
 * gone can only be a completed delivery whose completion did not persist
 * (impossible by construction, but cheap to tolerate): it is completed.
 * Claims of the other kinds complete in the same transaction as their
 * enqueue, so an expired `processing` one is a claim whose enqueue never
 * happened — released, so the hub's retry is accepted.
 */
export async function recoverRemoteSessionInbox(
  now: number = Date.now(),
  options: { includeLive?: boolean; requireActor?: boolean } = {},
): Promise<number> {
  const requireActor = options.requireActor ?? remoteSessionRequireActor();
  let recovered = 0;
  // Every release below runs under the request lock and is a
  // compare-and-delete on exactly the claim read here (digest + lease): the
  // list is read once, and a hub retry may take a stale claim over and
  // complete it while an earlier iteration awaits its delivery.
  const releaseAsRead = (claim: RemoteSessionInboxClaimRecord) =>
    withRequestLock(claim.requestId, async () =>
      releaseRemoteSessionInboxClaim(claim.requestId, {
        payloadHash: claim.payloadHash,
        leaseUntil: claim.leaseUntil,
      }),
    );
  for (const claim of listExpiredRemoteSessionInboxClaims(now, options)) {
    if (claim.kind !== "ask-reply") {
      await releaseAsRead(claim);
      continue;
    }
    const envelope = readRemoteSessionInboxEnvelope(claim.payload);
    if (
      !envelope ||
      envelope.delivery.kind !== "ask-reply" ||
      envelope.delivery.requestId !== claim.requestId ||
      remoteSessionInboxClaimHash(envelope) !== claim.payloadHash
    ) {
      logger.warn(
        { requestId: claim.requestId, legacy: !envelope },
        "session-comm: interrupted remote ask reply has no verifiable envelope; dropping it (the hub's retry is re-checked)",
      );
      await releaseAsRead(claim);
      continue;
    }
    const delivery = envelope.delivery;
    const outcome = await withRequestLock(claim.requestId, async () => {
      // Re-take the lease under the lock; a concurrent hub retry may have
      // beaten us to it.
      const retaken = claimRemoteSessionInbox({
        requestId: claim.requestId,
        kind: claim.kind,
        topicId: claim.topicId,
        payloadHash: claim.payloadHash,
        payload: envelope,
        now,
        force: options.includeLive === true,
      });
      if (retaken !== "claimed") return retaken;
      const ask = getRemoteSessionAsk(claim.requestId);
      if (!ask) {
        completeRemoteSessionInboxClaim(claim.requestId);
        return "completed-orphan";
      }
      const refusal = recoveredAskReplyRefusal(envelope, ask, claim.topicId, requireActor);
      if (refusal) {
        logger.warn(
          { requestId: claim.requestId, callerTopicId: claim.topicId, reason: refusal },
          "session-comm: interrupted remote ask reply failed re-verification; dropping it",
        );
        releaseRemoteSessionInboxClaim(claim.requestId, { payloadHash: claim.payloadHash });
        return "refused";
      }
      const result = await runAskReplyDelivery(ask, delivery, claim.payloadHash);
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
