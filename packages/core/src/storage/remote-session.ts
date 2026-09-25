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
import { PENDING_ASK_TTL_MS } from "#storage/session-asks";
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

export function releaseRemoteSessionInboxClaim(requestId: string): boolean {
  const result = db
    .query("DELETE FROM remote_session_inbox_claims WHERE request_id = ?")
    .run(requestId);
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
}

interface RemoteSessionAskRow {
  request_id: string;
  caller_topic_id: string;
  user_id: string;
  from_key: string;
  to_key: string;
  caller_thread_root_id: string | null;
  created_at: number | bigint;
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
  };
}

/** Remember an outbound remote ask before the hub is asked to forward it. */
export function recordRemoteSessionAsk(
  args: Omit<RemoteSessionAskRecord, "createdAt"> & { createdAt?: number },
): void {
  db.query(
    `INSERT INTO remote_session_asks
       (request_id, caller_topic_id, user_id, from_key, to_key, caller_thread_root_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET
       caller_topic_id = excluded.caller_topic_id,
       user_id = excluded.user_id,
       from_key = excluded.from_key,
       to_key = excluded.to_key,
       caller_thread_root_id = excluded.caller_thread_root_id,
       created_at = excluded.created_at`,
  ).run(
    args.requestId,
    args.callerTopicId,
    args.userId,
    args.fromKey,
    args.toKey,
    args.callerThreadRootId ?? null,
    args.createdAt ?? Date.now(),
  );
}

export function getRemoteSessionAsk(requestId: string): RemoteSessionAskRecord | null {
  const row = db
    .query<RemoteSessionAskRow, [string]>("SELECT * FROM remote_session_asks WHERE request_id = ?")
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

export function purgeStaleRemoteSessionAsks(now: number = Date.now()): number {
  const result = db
    .query("DELETE FROM remote_session_asks WHERE created_at < ?")
    .run(now - PENDING_ASK_TTL_MS);
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
