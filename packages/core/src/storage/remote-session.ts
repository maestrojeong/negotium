/**
 * Durable state for hub-routed remote session-comm (the `node/topic` branch
 * of `tell_session` / `ask_session` / `abort_session` on the `otium` surface).
 *
 * Three small tables, all keyed by the hub's per-call `requestId`:
 *
 * - `remote_session_inbox_claims` — idempotency for what the hub delivers into
 *   this node (`POST /topics/:id/session-comm/inbox`). A claim is a small state
 *   machine: `processing` (held under a lease while the delivery is being
 *   handed off) → `completed`. Only a `completed` claim answers a retried
 *   delivery with a replay; a duplicate that meets a `processing` claim is told
 *   to come back (`in_progress`), and a `processing` claim whose lease expired
 *   (the process died mid-delivery) is taken over and re-run. The same id with
 *   a different payload is a conflict.
 * - `remote_session_asks` — the caller side of a remote `ask_session`: which
 *   room asked, so the hub's `ask-reply` delivery can be routed back into it
 *   after this process restarted.
 * - `remote_session_reply_outbox` — the target side of a remote ask: the
 *   answer waiting to be posted to the hub with its one-shot reply token,
 *   retried until the hub acknowledges it or the pending-ask TTL passes.
 */
import { createHash } from "node:crypto";
import { db } from "#storage/forum-db";
import { PENDING_ASK_TTL_MS, releasePendingAsk } from "#storage/session-asks";
import { registerStorageSchemaInitializer } from "#storage/storage-host";

registerStorageSchemaInitializer((database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS remote_session_inbox_claims (
      request_id   TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      topic_id     TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remote_session_inbox_claims_created
      ON remote_session_inbox_claims(created_at);
    CREATE TABLE IF NOT EXISTS remote_session_asks (
      request_id            TEXT PRIMARY KEY,
      caller_topic_id       TEXT NOT NULL,
      user_id               TEXT NOT NULL,
      from_key              TEXT NOT NULL,
      to_key                TEXT NOT NULL,
      caller_thread_root_id TEXT,
      created_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remote_session_asks_caller
      ON remote_session_asks(caller_topic_id);
    CREATE TABLE IF NOT EXISTS remote_session_reply_outbox (
      request_id      TEXT PRIMARY KEY,
      hub_url         TEXT NOT NULL,
      token           TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK (kind IN ('reply', 'error')),
      reply_text      TEXT NOT NULL,
      from_label      TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT
    );
  `);
  // Claim state machine (added after the table existed, so guarded): a claim
  // is `processing` under a lease until its delivery is durably recorded, then
  // `completed`. `payload_json` keeps what a `processing` ask-reply must
  // deliver so an expired lease can be re-run after a restart.
  for (const ddl of [
    "ALTER TABLE remote_session_inbox_claims ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'",
    "ALTER TABLE remote_session_inbox_claims ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE remote_session_inbox_claims ADD COLUMN payload_json TEXT",
    // Outbound ask state (see `RemoteSessionAskDispatchState`). Rows that
    // predate the column may or may not have reached the hub: `dispatched`
    // (reconciled to `unknown`).
    "ALTER TABLE remote_session_asks ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'dispatched'",
  ]) {
    try {
      database.exec(ddl);
    } catch {
      // Column already present.
    }
  }
}, 36);

/** Claims older than this are forgotten; the hub never retries a call this late. */
export const REMOTE_SESSION_INBOX_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
/** A reply the hub has not acknowledged by then is dropped: the caller's pending ask has timed out. */
export const REMOTE_SESSION_REPLY_OUTBOX_TTL_MS = PENDING_ASK_TTL_MS;
/** Poll cadence of the reply outbox worker; individual rows back off (see {@link remoteSessionRetryDelayMs}). */
export const REMOTE_SESSION_REPLY_RETRY_MS = 5_000;
/** Backoff ladder for a reply the hub did not accept: 5, 10, 20, 30 s (cap), with jitter. */
export const REMOTE_SESSION_REPLY_BACKOFF_BASE_MS = 5_000;
export const REMOTE_SESSION_REPLY_BACKOFF_MAX_MS = 30_000;
/**
 * How long a `processing` claim is held before another delivery (a hub retry
 * or the maintenance pass) may take it over. Longer than any single delivery
 * attempt, so a live process is never raced by its own retry.
 */
export const REMOTE_SESSION_INBOX_CLAIM_LEASE_MS = 60_000;

export type RemoteSessionInboxKind = "tell" | "ask" | "abort" | "ask-reply";
export type RemoteSessionInboxClaimState = "processing" | "completed";
/**
 * `claimed`: this caller now holds the `processing` lease (fresh, or taken
 * over from an expired one). `replay`: a `completed` claim with the same
 * payload. `in_progress`: another delivery holds a live lease. `conflict`:
 * the id is bound to a different payload/kind/room.
 */
export type RemoteSessionInboxClaimOutcome = "claimed" | "replay" | "in_progress" | "conflict";

/**
 * Delay before retry number `attempts` (1-based: the first retry after the
 * immediate attempt is `attempts = 1`): 5, 10, 20, 30 s and 30 s thereafter,
 * each with ±20 % jitter from `random` (injectable for deterministic tests).
 */
export function remoteSessionRetryDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const step = Math.max(0, Math.floor(attempts) - 1);
  const base = Math.min(
    REMOTE_SESSION_REPLY_BACKOFF_BASE_MS * 2 ** step,
    REMOTE_SESSION_REPLY_BACKOFF_MAX_MS,
  );
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, random()));
  return Math.round(base * jitter);
}

/**
 * Stable digest of a value. The inbox hashes its actor-bound claim identity
 * (`remoteSessionInboxClaimIdentity` in `#runtime/remote-session-inbox`), so
 * a retried delivery is recognised as one only under the same principal.
 */
export function remoteSessionPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

interface InboxClaimRow {
  kind: string;
  topic_id: string;
  payload_hash: string;
  state: RemoteSessionInboxClaimState;
  lease_until: number | bigint;
  payload_json: string | null;
  created_at: number | bigint;
}

export interface RemoteSessionInboxClaimRecord {
  requestId: string;
  kind: RemoteSessionInboxKind;
  topicId: string;
  payloadHash: string;
  state: RemoteSessionInboxClaimState;
  leaseUntil: number;
  payload: unknown;
  createdAt: number;
}

/**
 * Claim one hub delivery as `processing` under a lease. For tell/ask/abort
 * the caller completes it in the same transaction as the enqueue; for an
 * ask-reply it stays `processing` — with `payload` persisted — until the
 * answer is durably in the caller's room, or is released so the hub's retry
 * runs the delivery again.
 */
export function claimRemoteSessionInbox(args: {
  requestId: string;
  kind: RemoteSessionInboxKind;
  topicId: string;
  payloadHash: string;
  /** Persisted while `processing` so an interrupted delivery can be re-run. */
  payload?: unknown;
  now?: number;
  leaseMs?: number;
  /** Take over even a live lease (a fresh process knows nobody holds one). */
  force?: boolean;
  /**
   * The digest a node before the actor-bound hash would have stored for this
   * delivery (payload only, no principal). A claim bearing it was written by
   * that version: `completed` answers a replay (no side effect), `processing`
   * is taken over and re-bound to `payloadHash`/`payload` — the caller has
   * already verified the principal of the delivery it is re-running.
   */
  legacyPayloadHash?: string;
}): RemoteSessionInboxClaimOutcome {
  const now = args.now ?? Date.now();
  const leaseUntil = now + (args.leaseMs ?? REMOTE_SESSION_INBOX_CLAIM_LEASE_MS);
  const payloadJson = args.payload === undefined ? null : JSON.stringify(args.payload);
  return db.transaction((): RemoteSessionInboxClaimOutcome => {
    const inserted = db
      .query(
        `INSERT OR IGNORE INTO remote_session_inbox_claims
           (request_id, kind, topic_id, payload_hash, created_at, state, lease_until, payload_json)
         VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)`,
      )
      .run(args.requestId, args.kind, args.topicId, args.payloadHash, now, leaseUntil, payloadJson);
    if (Number(inserted.changes ?? 0) === 1) return "claimed";
    const existing = db
      .query<InboxClaimRow, [string]>(
        "SELECT * FROM remote_session_inbox_claims WHERE request_id = ?",
      )
      .get(args.requestId);
    const legacy =
      args.legacyPayloadHash !== undefined && existing?.payload_hash === args.legacyPayloadHash;
    if (
      !existing ||
      existing.kind !== args.kind ||
      existing.topic_id !== args.topicId ||
      (existing.payload_hash !== args.payloadHash && !legacy)
    ) {
      return "conflict";
    }
    if (existing.state === "completed") return "replay";
    if (!args.force && Number(existing.lease_until) > now) return "in_progress";
    // The previous holder died (or hung past its lease): take the claim over.
    // A legacy claim is re-bound to the actor-bound digest and envelope, so
    // recovery never meets it again in its unverifiable form.
    db.query(
      `UPDATE remote_session_inbox_claims
       SET lease_until = ?, payload_json = COALESCE(?, payload_json), payload_hash = ?
       WHERE request_id = ?`,
    ).run(leaseUntil, payloadJson, args.payloadHash, args.requestId);
    return "claimed";
  })();
}

/** The delivery is durably recorded: replays may now be acknowledged. */
export function completeRemoteSessionInboxClaim(
  requestId: string,
  now: number = Date.now(),
): boolean {
  const result = db
    .query(
      `UPDATE remote_session_inbox_claims
       SET state = 'completed', lease_until = ?, payload_json = NULL
       WHERE request_id = ? AND state = 'processing'`,
    )
    .run(now, requestId);
  return Number(result.changes ?? 0) === 1;
}

export function getRemoteSessionInboxClaim(
  requestId: string,
): RemoteSessionInboxClaimRecord | null {
  const row = db
    .query<InboxClaimRow & { request_id: string }, [string]>(
      "SELECT * FROM remote_session_inbox_claims WHERE request_id = ?",
    )
    .get(requestId);
  return row ? toClaimRecord(row) : null;
}

function toClaimRecord(row: InboxClaimRow & { request_id: string }): RemoteSessionInboxClaimRecord {
  let payload: unknown = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = null;
    }
  }
  return {
    requestId: row.request_id,
    kind: row.kind as RemoteSessionInboxKind,
    topicId: row.topic_id,
    payloadHash: row.payload_hash,
    state: row.state,
    leaseUntil: Number(row.lease_until),
    payload,
    createdAt: Number(row.created_at),
  };
}

/** `processing` claims whose lease ran out: deliveries a dead process left behind. */
export function listExpiredRemoteSessionInboxClaims(
  now: number = Date.now(),
  options: { includeLive?: boolean } = {},
): RemoteSessionInboxClaimRecord[] {
  return db
    .query<InboxClaimRow & { request_id: string }, [number]>(
      `SELECT * FROM remote_session_inbox_claims
       WHERE state = 'processing' AND lease_until <= ?
       ORDER BY created_at ASC`,
    )
    .all(options.includeLive ? Number.MAX_SAFE_INTEGER : now)
    .map(toClaimRecord);
}

/**
 * Hand a `processing` claim back so the hub's retry runs the delivery again.
 *
 * A compare-and-delete: only the claim the caller holds — still
 * `processing`, still bound to `expected.payloadHash` and, when given, still
 * under the exact lease the caller read — is deleted. A claim a live delivery
 * has meanwhile completed (or taken over / re-bound) is never deleted: losing
 * a `completed` row would turn the hub's next retry into a 404 (an ask-reply
 * whose answer already landed) or a second enqueue (tell/ask/abort).
 */
export function releaseRemoteSessionInboxClaim(
  requestId: string,
  expected: { payloadHash: string; leaseUntil?: number },
): boolean {
  const result = db
    .query(
      `DELETE FROM remote_session_inbox_claims
       WHERE request_id = ? AND state = 'processing' AND payload_hash = ?
         AND (? IS NULL OR lease_until = ?)`,
    )
    .run(requestId, expected.payloadHash, expected.leaseUntil ?? null, expected.leaseUntil ?? null);
  return Number(result.changes ?? 0) === 1;
}

export function purgeRemoteSessionInboxClaims(now: number = Date.now()): number {
  const result = db
    .query("DELETE FROM remote_session_inbox_claims WHERE created_at < ?")
    .run(now - REMOTE_SESSION_INBOX_CLAIM_TTL_MS);
  return Number(result.changes ?? 0);
}

export interface RemoteSessionAskRecord {
  requestId: string;
  callerTopicId: string;
  userId: string;
  fromKey: string;
  toKey: string;
  callerThreadRootId?: string;
  createdAt: number;
  /** Where the outbound ask stands; see {@link RemoteSessionAskDispatchState}. */
  dispatchState?: RemoteSessionAskDispatchState;
}

interface RemoteSessionAskRow {
  request_id: string;
  caller_topic_id: string;
  user_id: string;
  from_key: string;
  to_key: string;
  caller_thread_root_id: string | null;
  created_at: number | bigint;
  dispatch_state: RemoteSessionAskDispatchState;
}

function toAskRecord(row: RemoteSessionAskRow): RemoteSessionAskRecord {
  return {
    requestId: row.request_id,
    callerTopicId: row.caller_topic_id,
    userId: row.user_id,
    fromKey: row.from_key,
    toKey: row.to_key,
    ...(row.caller_thread_root_id ? { callerThreadRootId: row.caller_thread_root_id } : {}),
    createdAt: Number(row.created_at),
    dispatchState: row.dispatch_state,
  };
}

/**
 * One state machine for the outbound hub ask: the durable row *and* the
 * caller's pending marker (a file) it may hold. Invariant: the row is never
 * deleted while its marker may still exist — the marker is released first
 * (requestId-scoped, idempotent: {@link releasePendingAsk}) and the row goes
 * only once that succeeded, so a marker is always findable through its row.
 *
 * - `prepared`: row written, marker maybe; the hub has certainly not been called.
 * - `dispatched`: the hub call is in flight (or its process died during it, or
 *   it ended "uncertain"); the hub may hold the ask. Row + marker.
 * - `sent`: the hub acknowledged the ask. Row + marker until the reply lands
 *   (the reply path consumes both) or the TTL passes.
 * - `abandoned`: no reply can come (the hub refused, or registration failed)
 *   but the marker could not be released yet; reconciliation retries.
 * - `unknown`: a `dispatched` ask whose outcome nobody will learn (the hub
 *   call's grant is per-turn, so neither an idempotent resend nor a hub status
 *   query is possible after the fact). Marker released so the room can ask
 *   again; row kept so a late reply is still routed; at the TTL the caller is
 *   told no reply arrived.
 * - `expired`: an `unknown` ask whose "no reply arrived" notice is being
 *   delivered; invisible to the reply path, removed with the notice's record.
 *
 * prepared ─marker─▶ dispatched ─hub ok─▶ sent ─reply/TTL─▶ ∅
 *    │                 │  └─hub refused─▶ abandoned ─release─▶ ∅
 *    └─fail/grace─▶ release ─▶ ∅ (or abandoned)
 *                      └─crash/uncertain + grace ─release─▶ unknown ─reply─▶ ∅
 *                                                     └─TTL─▶ expired ─notice─▶ ∅
 */
export type RemoteSessionAskDispatchState =
  | "prepared"
  | "dispatched"
  | "sent"
  | "abandoned"
  | "unknown"
  | "expired";

/**
 * A `prepared` row older than this belongs to a process that died between
 * writing it and calling the hub: prepare → marker → dispatched is
 * synchronous, so a live one is never this old.
 */
export const REMOTE_SESSION_ASK_PREPARE_GRACE_MS = 60_000;
/**
 * A `dispatched` row older than this is not waiting on a live hub call: one
 * `hubRemoteAsk` is bounded by 3 attempts × 15 s (+ backoff), so the caller
 * has long since either confirmed it (`sent`) or given up on knowing.
 */
export const REMOTE_SESSION_ASK_DISPATCH_GRACE_MS = 2 * 60_000;

/** Remember an outbound remote ask before the hub is asked to forward it. */
export function recordRemoteSessionAsk(
  args: Omit<RemoteSessionAskRecord, "createdAt" | "dispatchState"> & {
    createdAt?: number;
    /** Defaults to `sent` (an ask the hub holds); the hub-ask path passes `prepared`. */
    dispatchState?: RemoteSessionAskDispatchState;
  },
): void {
  db.query(
    `INSERT INTO remote_session_asks
       (request_id, caller_topic_id, user_id, from_key, to_key, caller_thread_root_id, created_at,
        dispatch_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET
       caller_topic_id = excluded.caller_topic_id,
       user_id = excluded.user_id,
       from_key = excluded.from_key,
       to_key = excluded.to_key,
       caller_thread_root_id = excluded.caller_thread_root_id,
       created_at = excluded.created_at,
       dispatch_state = excluded.dispatch_state`,
  ).run(
    args.requestId,
    args.callerTopicId,
    args.userId,
    args.fromKey,
    args.toKey,
    args.callerThreadRootId ?? null,
    args.createdAt ?? Date.now(),
    args.dispatchState ?? "sent",
  );
}

/** Compare-and-set of the dispatch state; `false` if the row is not in `from`. */
function moveRemoteSessionAsk(
  requestId: string,
  from: RemoteSessionAskDispatchState,
  to: RemoteSessionAskDispatchState,
): boolean {
  const result = db
    .query(
      "UPDATE remote_session_asks SET dispatch_state = ? WHERE request_id = ? AND dispatch_state = ?",
    )
    .run(to, requestId, from);
  return Number(result.changes ?? 0) === 1;
}

/** Compare-and-delete: drop the row only if it is still in `state`. */
function deleteRemoteSessionAskInState(
  requestId: string,
  state: RemoteSessionAskDispatchState,
): boolean {
  const result = db
    .query("DELETE FROM remote_session_asks WHERE request_id = ? AND dispatch_state = ?")
    .run(requestId, state);
  return Number(result.changes ?? 0) === 1;
}

/** The hub call is about to be made: from now on the hub may hold the ask. */
export function markRemoteSessionAskDispatched(requestId: string): boolean {
  return moveRemoteSessionAsk(requestId, "prepared", "dispatched");
}

/**
 * The hub acknowledged the ask. Best effort: a row left `dispatched` (this
 * write failed, or the reply already consumed the row) is still correct —
 * reconciliation merely treats it as `unknown` after the grace.
 */
export function markRemoteSessionAskSent(requestId: string): boolean {
  try {
    return moveRemoteSessionAsk(requestId, "dispatched", "sent");
  } catch {
    return false;
  }
}

/** `true` when no marker of this ask remains; a throw counts as "still held". */
function tryRelease(release: () => boolean): boolean {
  try {
    return release() === true;
  } catch {
    return false;
  }
}

/**
 * Drop the row only once its marker is released; otherwise park it as
 * `abandoned` (from `state`) so reconciliation retries the release. If even
 * that write fails the row keeps `state`, which reconciliation also covers.
 */
function retireRemoteSessionAsk(
  requestId: string,
  state: RemoteSessionAskDispatchState,
  release: () => boolean,
): void {
  try {
    if (tryRelease(release)) deleteRemoteSessionAskInState(requestId, state);
    else if (state !== "abandoned") moveRemoteSessionAsk(requestId, state, "abandoned");
  } catch {
    // Row left as it was: reconciliation retries from that state.
  }
}

/**
 * Register an outbound hub ask: durable caller row (`prepared`), then the
 * caller's pending marker, then `dispatched` — only after this returns `ok`
 * may the hub be called. A failure retires what was written without ever
 * orphaning the marker: the row is deleted only after `releaseMarker`
 * confirmed the marker is gone, else it stays (`abandoned`/`prepared`) for
 * {@link reconcileRemoteSessionAsks}. `pending` means another ask to that
 * room is outstanding (its marker is not ours and is never touched).
 */
export function beginRemoteSessionAsk(
  args: Omit<RemoteSessionAskRecord, "createdAt" | "dispatchState"> & {
    createMarker: () => boolean;
    /** RequestId-scoped, idempotent: `true` once no marker of this ask remains. */
    releaseMarker: () => boolean;
  },
): "ok" | "pending" {
  const { createMarker, releaseMarker, ...record } = args;
  recordRemoteSessionAsk({ ...record, dispatchState: "prepared" });
  let created: boolean;
  try {
    created = createMarker();
  } catch (err) {
    // A throwing create may still have left a (partial) marker file.
    retireRemoteSessionAsk(record.requestId, "prepared", releaseMarker);
    throw err;
  }
  if (!created) {
    // The slot belongs to another ask: its marker is never touched.
    retireRemoteSessionAsk(record.requestId, "prepared", () => true);
    return "pending";
  }
  try {
    if (!markRemoteSessionAskDispatched(record.requestId)) {
      throw new Error("remote session ask row vanished before dispatch");
    }
  } catch (err) {
    retireRemoteSessionAsk(record.requestId, "prepared", releaseMarker);
    throw err;
  }
  return "ok";
}

/**
 * The hub definitively refused a `dispatched` ask (nothing was forwarded):
 * release the marker, then drop the row — or keep it `abandoned` until the
 * release succeeds.
 */
export function abandonRemoteSessionAsk(requestId: string, releaseMarker: () => boolean): void {
  retireRemoteSessionAsk(requestId, "dispatched", releaseMarker);
}

function releaseRowMarker(row: RemoteSessionAskRow): boolean {
  return tryRelease(() =>
    releasePendingAsk({
      userId: row.user_id,
      from: row.from_key,
      to: row.to_key,
      requestId: row.request_id,
    }),
  );
}

/**
 * Durable recovery of the outbound-ask state machine; runs in the
 * maintenance pass (at startup and then periodically). Idempotent.
 *
 * - `abandoned` (any age) and `prepared` past {@link REMOTE_SESSION_ASK_PREPARE_GRACE_MS}
 *   (the hub was never called): release the marker, then drop the row.
 * - `dispatched` past {@link REMOTE_SESSION_ASK_DISPATCH_GRACE_MS} (the
 *   process died around the hub call, or the call ended uncertain): release
 *   the marker so the room can ask again, then mark the row `unknown`.
 *
 * A failed release leaves the row as it was, so the next pass retries; past
 * the ask TTL the marker is stale (it no longer blocks a new ask and is
 * swept on read), so the row moves on regardless.
 */
export function reconcileRemoteSessionAsks(
  now: number = Date.now(),
  opts: { prepareGraceMs?: number; dispatchGraceMs?: number } = {},
): { removed: number; unknown: number } {
  const prepareCutoff = now - (opts.prepareGraceMs ?? REMOTE_SESSION_ASK_PREPARE_GRACE_MS);
  const dispatchCutoff = now - (opts.dispatchGraceMs ?? REMOTE_SESSION_ASK_DISPATCH_GRACE_MS);
  const ttlCutoff = now - PENDING_ASK_TTL_MS;
  const rows = db
    .query<RemoteSessionAskRow, [number, number]>(
      `SELECT * FROM remote_session_asks
       WHERE dispatch_state = 'abandoned'
          OR (dispatch_state = 'prepared' AND created_at <= ?)
          OR (dispatch_state = 'dispatched' AND created_at <= ?)`,
    )
    .all(prepareCutoff, dispatchCutoff);
  let removed = 0;
  let unknown = 0;
  for (const row of rows) {
    const released = releaseRowMarker(row) || Number(row.created_at) < ttlCutoff;
    if (!released) continue;
    if (row.dispatch_state === "dispatched") {
      if (moveRemoteSessionAsk(row.request_id, "dispatched", "unknown")) unknown += 1;
    } else if (deleteRemoteSessionAskInState(row.request_id, row.dispatch_state)) {
      removed += 1;
    }
  }
  return { removed, unknown };
}

/**
 * Asks whose caller must now be told that no reply arrived: `unknown` past
 * the ask TTL, and `expired` ones whose notice did not land yet.
 */
export function listRemoteSessionAsksToExpire(now: number = Date.now()): RemoteSessionAskRecord[] {
  return db
    .query<RemoteSessionAskRow, [number]>(
      `SELECT * FROM remote_session_asks
       WHERE dispatch_state = 'expired' OR (dispatch_state = 'unknown' AND created_at < ?)
       ORDER BY created_at`,
    )
    .all(now - PENDING_ASK_TTL_MS)
    .map(toAskRecord);
}

/**
 * `unknown` → `expired`, unless a late reply is being delivered right now
 * (it holds an inbox claim for the same requestId): that reply wins.
 * From here on the reply path no longer sees the row.
 */
export function markRemoteSessionAskExpired(requestId: string): boolean {
  const result = db
    .query(
      `UPDATE remote_session_asks SET dispatch_state = 'expired'
       WHERE request_id = ? AND dispatch_state = 'unknown'
         AND NOT EXISTS (
           SELECT 1 FROM remote_session_inbox_claims
           WHERE request_id = ? AND kind = 'ask-reply' AND state = 'processing'
         )`,
    )
    .run(requestId, requestId);
  return Number(result.changes ?? 0) === 1;
}

/** The "no reply arrived" notice is durable: the `expired` row goes with it. */
export function deleteExpiredRemoteSessionAsk(requestId: string): boolean {
  return deleteRemoteSessionAskInState(requestId, "expired");
}

/** The ask a reply may still answer (an `expired` one no longer can). */
export function getRemoteSessionAsk(requestId: string): RemoteSessionAskRecord | null {
  const row = db
    .query<RemoteSessionAskRow, [string]>(
      "SELECT * FROM remote_session_asks WHERE request_id = ? AND dispatch_state <> 'expired'",
    )
    .get(requestId);
  return row ? toAskRecord(row) : null;
}

export function deleteRemoteSessionAsk(requestId: string): boolean {
  const result = db.query("DELETE FROM remote_session_asks WHERE request_id = ?").run(requestId);
  return Number(result.changes ?? 0) === 1;
}

/** Consume the caller record exactly once: the row is gone after this returns it. */
export function takeRemoteSessionAsk(requestId: string): RemoteSessionAskRecord | null {
  return db.transaction(() => {
    const record = getRemoteSessionAsk(requestId);
    if (record) deleteRemoteSessionAsk(requestId);
    return record;
  })();
}

export function deleteRemoteSessionAsksForTopic(callerTopicId: string): number {
  const result = db
    .query("DELETE FROM remote_session_asks WHERE caller_topic_id = ?")
    .run(callerTopicId);
  return Number(result.changes ?? 0);
}

/**
 * Forget asks past the TTL. Only states whose marker is settled go at the TTL
 * (`sent`: the marker is stale by then); the others are walked through
 * {@link reconcileRemoteSessionAsks} and the expiry notice first. Anything
 * still here at twice the TTL is dropped unconditionally (a caller room that
 * can no longer take the notice must not pin the row forever).
 */
export function purgeStaleRemoteSessionAsks(now: number = Date.now()): number {
  const result = db
    .query(
      `DELETE FROM remote_session_asks
       WHERE (dispatch_state = 'sent' AND created_at < ?) OR created_at < ?`,
    )
    .run(now - PENDING_ASK_TTL_MS, now - 2 * PENDING_ASK_TTL_MS);
  return Number(result.changes ?? 0);
}

export interface RemoteSessionReplyOutboxEntry {
  requestId: string;
  hubUrl: string;
  token: string;
  kind: "reply" | "error";
  replyText: string;
  fromLabel: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface RemoteSessionReplyOutboxRow {
  request_id: string;
  hub_url: string;
  token: string;
  kind: "reply" | "error";
  reply_text: string;
  from_label: string;
  created_at: number | bigint;
  attempts: number | bigint;
  next_attempt_at: number | bigint;
  last_error: string | null;
}

function toOutboxEntry(row: RemoteSessionReplyOutboxRow): RemoteSessionReplyOutboxEntry {
  return {
    requestId: row.request_id,
    hubUrl: row.hub_url,
    token: row.token,
    kind: row.kind,
    replyText: row.reply_text,
    fromLabel: row.from_label,
    createdAt: Number(row.created_at),
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

/**
 * Queue an answer for the hub. One row per ask: a second answer for the same
 * request (a retry after a partial failure) replaces the first, which is what
 * the hub's one-shot reply token would enforce anyway.
 */
export function upsertRemoteSessionReplyOutbox(args: {
  requestId: string;
  hubUrl: string;
  token: string;
  kind: "reply" | "error";
  replyText: string;
  fromLabel: string;
  createdAt?: number;
}): void {
  db.query(
    `INSERT INTO remote_session_reply_outbox
       (request_id, hub_url, token, kind, reply_text, from_label, created_at, attempts, next_attempt_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL)
     ON CONFLICT(request_id) DO UPDATE SET
       hub_url = excluded.hub_url,
       token = excluded.token,
       kind = excluded.kind,
       reply_text = excluded.reply_text,
       from_label = excluded.from_label,
       attempts = 0,
       next_attempt_at = 0,
       last_error = NULL`,
  ).run(
    args.requestId,
    args.hubUrl,
    args.token,
    args.kind,
    args.replyText,
    args.fromLabel,
    args.createdAt ?? Date.now(),
  );
}

export function listRemoteSessionReplyOutbox(
  args: { now?: number; limit?: number; due?: boolean } = {},
): RemoteSessionReplyOutboxEntry[] {
  const now = args.now ?? Date.now();
  const rows =
    args.due === false
      ? db
          .query<RemoteSessionReplyOutboxRow, [number]>(
            "SELECT * FROM remote_session_reply_outbox ORDER BY created_at LIMIT ?",
          )
          .all(args.limit ?? 100)
      : db
          .query<RemoteSessionReplyOutboxRow, [number, number]>(
            `SELECT * FROM remote_session_reply_outbox
           WHERE next_attempt_at <= ?
           ORDER BY created_at LIMIT ?`,
          )
          .all(now, args.limit ?? 100);
  return rows.map(toOutboxEntry);
}

export function deleteRemoteSessionReplyOutbox(requestId: string): boolean {
  const result = db
    .query("DELETE FROM remote_session_reply_outbox WHERE request_id = ?")
    .run(requestId);
  return Number(result.changes ?? 0) === 1;
}

/**
 * Record a failed attempt and schedule the next one on the backoff ladder
 * (5, 10, 20, 30 s cap, jittered) — the immediate first attempt is
 * `attempts = 0`, so the first deferral waits ≈5 s. `retryMs` pins the delay.
 */
export function deferRemoteSessionReplyOutbox(args: {
  requestId: string;
  error: string;
  now?: number;
  retryMs?: number;
  random?: () => number;
}): void {
  const now = args.now ?? Date.now();
  db.transaction(() => {
    const row = db
      .query<{ attempts: number | bigint }, [string]>(
        "SELECT attempts FROM remote_session_reply_outbox WHERE request_id = ?",
      )
      .get(args.requestId);
    if (!row) return;
    const attempts = Number(row.attempts) + 1;
    const delay = args.retryMs ?? remoteSessionRetryDelayMs(attempts, args.random);
    db.query(
      `UPDATE remote_session_reply_outbox
       SET attempts = ?, next_attempt_at = ?, last_error = ?
       WHERE request_id = ?`,
    ).run(attempts, now + delay, args.error.slice(0, 500), args.requestId);
  })();
}

/** Drop answers nobody is waiting for any more. Returns what was dropped, for the log. */
export function purgeExpiredRemoteSessionReplyOutbox(
  now: number = Date.now(),
): RemoteSessionReplyOutboxEntry[] {
  const cutoff = now - REMOTE_SESSION_REPLY_OUTBOX_TTL_MS;
  const expired = db
    .query<RemoteSessionReplyOutboxRow, [number]>(
      "SELECT * FROM remote_session_reply_outbox WHERE created_at < ?",
    )
    .all(cutoff)
    .map(toOutboxEntry);
  if (expired.length) {
    db.query("DELETE FROM remote_session_reply_outbox WHERE created_at < ?").run(cutoff);
  }
  return expired;
}
