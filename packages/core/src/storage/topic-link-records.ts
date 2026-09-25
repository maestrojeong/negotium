/**
 * Durable evidence for the hub↔node topic link (topic-link design v2 §4.2,
 * §4.5, PR7). Two tables, both written by the node and only ever read by a
 * host through the authenticated Runtime Gateway:
 *
 * - `api_topic_create_claims` — one row per host `requestId` on a room-creating
 *   request (`POST /topics`, `POST /topics/:id/derive`). Written inside the same
 *   SQLite transaction that inserts the topic, so a response lost after commit
 *   can always be replayed by id instead of being guessed at (title/parent
 *   heuristics are forbidden by the design).
 * - `api_topic_tombstones` — one row per topic that left the host-visible
 *   surface, stamped with THIS node's identity. Written by SQLite triggers on
 *   `api_topics`, so every delete path (gateway, MCP, CLI, account deletion,
 *   future ones) records it in the very statement that removes the row; there
 *   is no code path that can delete a topic and forget the tombstone.
 *
 * `api_node_identity` holds the node id the triggers stamp. The node process
 * records its `NODE_ID` there at start (and the delete cascade re-asserts it)
 * via {@link recordTopicLinkNodeIdentity}: a database copied to another install
 * keeps the old id on its old tombstones, so the existence API — which only
 * answers `gone` for a tombstone written under the identity it is answering
 * as — can never turn a copied store's history into a delete on the new node.
 * Until an identity is recorded, tombstones carry NULL and never count as
 * `gone` (fail-safe). This module deliberately does not import
 * `#platform/config`: that would create state paths merely by importing the
 * public storage facade.
 */

import { createHash } from "node:crypto";
// Side effect: registers `api_messages`, which the message fence trigger
// guards (and orders it before this schema).
import "#storage/api-messages";
import { db } from "#storage/forum-db";
// Side effect: registers `runtime_topic_state`, which the message fence
// trigger reads (and orders it before this schema).
import "#storage/runtime-topic-state";
import { registerStorageSchemaInitializer } from "#storage/storage-host";

export type TopicCreateClaimOp = "create" | "derive" | "abort";
export type TopicCreateClaimState = "committed" | "aborted";
export type TopicTombstoneReason = "deleted" | "unshared";

export interface TopicCreateClaim {
  principalKey: string;
  requestId: string;
  op: TopicCreateClaimOp;
  payloadHash: string;
  topicId: string | null;
  state: TopicCreateClaimState;
  nodeId: string | null;
  /** Highest `api_messages.rowid` of the topic when the claim committed (seeded history). */
  seedMaxMessageRowid: number;
  createdAt: string;
  updatedAt: string;
}

export interface TopicTombstone {
  seq: number;
  topicId: string;
  nodeId: string | null;
  reason: TopicTombstoneReason;
  surface: string | null;
  surfaceScope: string | null;
  deletedAt: string;
}

interface ClaimRow {
  principal_key: string;
  request_id: string;
  op: string;
  payload_hash: string;
  topic_id: string | null;
  state: string;
  node_id: string | null;
  seed_max_message_rowid: number | bigint | null;
  created_at: string;
  updated_at: string;
}

interface TombstoneRow {
  seq: number | bigint;
  topic_id: string;
  node_id: string | null;
  reason: string;
  surface: string | null;
  surface_scope: string | null;
  deleted_at: string;
}

/** Claims are kept at least this long (design v2 §4.2: ≥ 30 days). */
export const TOPIC_CREATE_CLAIM_RETENTION_MS = 30 * 24 * 60 * 60_000;

const NODE_IDENTITY_SQL = "(SELECT node_id FROM api_node_identity WHERE singleton = 1)";
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const TOMBSTONE_SEQ_SQL = "(SELECT seq FROM api_topic_tombstone_seq WHERE singleton = 1)";
// Advances the never-decreasing tombstone sequence. Runs as the first
// statement of every tombstone-writing trigger, so the new row's seq is read
// back from the counter within the same statement/transaction.
const BUMP_TOMBSTONE_SEQ_SQL =
  "UPDATE api_topic_tombstone_seq SET seq = seq + 1 WHERE singleton = 1";
const NEW_EPOCH_SQL = "lower(hex(randomblob(16)))";

/**
 * Owner-id prefix of the runtime maintenance fence a claim abort holds while
 * it deletes the claimed topic. While such a fence is live, the
 * `api_messages_claim_abort_fence` trigger refuses every message insert into
 * that topic (any writer, any process), so nothing can land between the
 * abort's "no new messages" check and the delete.
 */
export const TOPIC_CLAIM_ABORT_OWNER_PREFIX = "topic-link-abort:";
/** The message the fence trigger raises; matched by ingress to answer 409. */
export const TOPIC_CLAIM_ABORT_FENCE_ERROR = "topic_claim_abort_in_progress";
// Same staleness rule as `runtime-topic-state` (TOPIC_MAINTENANCE_STALE_MS):
// a crashed abort never blocks a room for longer than a stale fence.
const CLAIM_ABORT_FENCE_STALE_MS = 30_000;
const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const CLAIM_ABORT_FENCE_PREDICATE = `maintenance = 1
  AND maintenance_owner LIKE '${TOPIC_CLAIM_ABORT_OWNER_PREFIX}%'
  AND heartbeat_at IS NOT NULL
  AND heartbeat_at >= ${NOW_MS_SQL} - ${CLAIM_ABORT_FENCE_STALE_MS}`;

type SchemaDatabase = {
  exec(sql: string): unknown;
  transaction<T>(fn: () => T): (() => T) & { immediate?: () => T };
  query(sql: string): { all(...params: never[]): unknown[] };
};

const SCHEMA_TABLES = [
  "api_node_identity",
  "api_topic_create_claims",
  "api_topic_tombstones",
  "api_topic_tombstone_seq",
];
const SCHEMA_INDEXES = ["idx_api_topic_create_claims_topic", "idx_api_topic_create_claims_created"];
const SCHEMA_INDEXES_TOMBSTONES = ["idx_api_topic_tombstones_seq"];
/** Trigger → a marker its current SQL must contain (older builds lack it). */
const SCHEMA_TRIGGERS: Record<string, string> = {
  api_topics_tombstone_on_delete: "api_topic_tombstone_seq",
  api_topics_tombstone_on_unshare: "api_topic_tombstone_seq",
  api_topics_tombstone_on_reshare: "api_topic_tombstones",
  api_topics_tombstone_on_insert: "api_topic_tombstones",
  api_messages_claim_abort_fence: TOPIC_CLAIM_ABORT_OWNER_PREFIX,
};

/**
 * Read-only: whether the schema (and identity) is already current. Every
 * process start runs the initializer, so the common path must not write — a
 * write here would take the database lock on every boot and can fail with
 * SQLITE_BUSY while other processes start concurrently.
 */
function topicLinkSchemaIsCurrent(database: SchemaDatabase, nodeId?: string): boolean {
  const objects = new Map(
    (
      database
        .query("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index','trigger')")
        .all() as Array<{ name: string; sql: string | null }>
    ).map((row) => [row.name, row.sql ?? ""]),
  );
  for (const name of [...SCHEMA_TABLES, ...SCHEMA_INDEXES, ...SCHEMA_INDEXES_TOMBSTONES]) {
    if (!objects.has(name)) return false;
  }
  for (const [name, marker] of Object.entries(SCHEMA_TRIGGERS)) {
    if (!objects.get(name)?.includes(marker)) return false;
  }
  if (!columnNames(database, "api_node_identity").has("epoch_id")) return false;
  const identity = database
    .query("SELECT node_id, epoch_id FROM api_node_identity WHERE singleton = 1")
    .all() as Array<{ node_id: string; epoch_id: string | null }>;
  if (identity.some((row) => row.epoch_id === null)) return false;
  if (nodeId && identity[0]?.node_id !== nodeId) return false;
  const counter = database
    .query(
      `SELECT (SELECT seq FROM api_topic_tombstone_seq WHERE singleton = 1) AS counter,
              (SELECT COALESCE(MAX(seq), 0) FROM api_topic_tombstones) AS max_seq`,
    )
    .all() as Array<{ counter: number | bigint | null; max_seq: number | bigint }>;
  const row = counter[0];
  return row?.counter !== null && row?.counter !== undefined && row.counter >= row.max_seq;
}

function columnNames(database: SchemaDatabase, table: string): Set<string> {
  const rows = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Idempotent, and all-or-nothing: every statement is `IF NOT EXISTS` / an
 * upsert / a drop-and-recreate of a trigger, and the whole set runs in one
 * transaction so a crash half-way never leaves triggers without the table
 * they write to.
 */
export function initializeTopicLinkRecordsSchema(database: SchemaDatabase, nodeId?: string): void {
  if (topicLinkSchemaIsCurrent(database, nodeId)) return;
  const migrate = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_node_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        node_id TEXT NOT NULL,
        epoch_id TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    // PR7 fix: a random id minted when this store first records an identity.
    // Survives NODE_ID changes; a wiped/recreated store gets a new one.
    if (!columnNames(database, "api_node_identity").has("epoch_id")) {
      database.exec("ALTER TABLE api_node_identity ADD COLUMN epoch_id TEXT");
    }
    database.exec(
      `UPDATE api_node_identity SET epoch_id = ${NEW_EPOCH_SQL} WHERE epoch_id IS NULL`,
    );
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_topic_create_claims (
        principal_key TEXT NOT NULL,
        request_id TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('create','derive','abort')),
        payload_hash TEXT NOT NULL,
        topic_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('committed','aborted')),
        node_id TEXT,
        seed_max_message_rowid INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (principal_key, request_id)
      )
    `);
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_api_topic_create_claims_topic ON api_topic_create_claims(topic_id)",
    );
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_api_topic_create_claims_created ON api_topic_create_claims(created_at)",
    );
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_topic_tombstones (
        topic_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        node_id TEXT,
        reason TEXT NOT NULL CHECK (reason IN ('deleted','unshared')),
        surface TEXT,
        surface_scope TEXT,
        deleted_at TEXT NOT NULL
      )
    `);
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_api_topic_tombstones_seq ON api_topic_tombstones(seq)",
    );
    // Never-decreasing tombstone sequence (PR7 fix). `api_topic_tombstones` is
    // a current-state table whose rows are deleted on reshare/reinsert, so
    // MAX(seq)+1 could hand out a seq a cursor already passed. Seeded from the
    // table on every init, and never lowered.
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_topic_tombstone_seq (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        seq INTEGER NOT NULL
      )
    `);
    database.exec(`
      INSERT INTO api_topic_tombstone_seq (singleton, seq)
      VALUES (1, (SELECT COALESCE(MAX(seq), 0) FROM api_topic_tombstones))
      ON CONFLICT(singleton) DO UPDATE SET seq = MAX(api_topic_tombstone_seq.seq, excluded.seq)
    `);
    // Recreated on every init so a store migrated by an earlier build (whose
    // triggers computed MAX(seq)+1) gets the counter-based versions.
    for (const name of [
      "api_topics_tombstone_on_delete",
      "api_topics_tombstone_on_unshare",
      "api_topics_tombstone_on_reshare",
      "api_topics_tombstone_on_insert",
      "api_messages_claim_abort_fence",
    ]) {
      database.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    // Hard delete, from any writer. `DROP TABLE` (the legacy schema rebuild)
    // does not fire row triggers, so a migration never fabricates tombstones.
    database.exec(`
      CREATE TRIGGER api_topics_tombstone_on_delete
      AFTER DELETE ON api_topics
      BEGIN
        ${BUMP_TOMBSTONE_SEQ_SQL};
        INSERT OR REPLACE INTO api_topic_tombstones
          (topic_id, seq, node_id, reason, surface, surface_scope, deleted_at)
        VALUES
          (OLD.id, ${TOMBSTONE_SEQ_SQL}, ${NODE_IDENTITY_SQL}, 'deleted',
           OLD.surface, OLD.surface_scope, ${NOW_SQL});
      END
    `);
    // Left the Otium surface (moved to another surface or hidden). Evidence of
    // a withdrawal, never of a deletion: the existence API still answers
    // `present` for such a topic.
    database.exec(`
      CREATE TRIGGER api_topics_tombstone_on_unshare
      AFTER UPDATE OF surface, visibility ON api_topics
      WHEN OLD.surface = 'otium' AND COALESCE(OLD.visibility, 'visible') != 'hidden'
        AND (NEW.surface IS NOT 'otium' OR NEW.visibility = 'hidden')
      BEGIN
        ${BUMP_TOMBSTONE_SEQ_SQL};
        INSERT OR REPLACE INTO api_topic_tombstones
          (topic_id, seq, node_id, reason, surface, surface_scope, deleted_at)
        VALUES
          (OLD.id, ${TOMBSTONE_SEQ_SQL}, ${NODE_IDENTITY_SQL}, 'unshared',
           OLD.surface, OLD.surface_scope, ${NOW_SQL});
      END
    `);
    database.exec(`
      CREATE TRIGGER api_topics_tombstone_on_reshare
      AFTER UPDATE OF surface, visibility ON api_topics
      WHEN NEW.surface = 'otium' AND COALESCE(NEW.visibility, 'visible') != 'hidden'
      BEGIN
        DELETE FROM api_topic_tombstones WHERE topic_id = NEW.id AND reason = 'unshared';
      END
    `);
    // A row that exists again (restored or re-inserted id) is not gone.
    database.exec(`
      CREATE TRIGGER api_topics_tombstone_on_insert
      AFTER INSERT ON api_topics
      BEGIN
        DELETE FROM api_topic_tombstones WHERE topic_id = NEW.id;
      END
    `);
    // A topic a claim abort is deleting accepts no message (PR7 fix): see
    // TOPIC_CLAIM_ABORT_OWNER_PREFIX. Checked by SQLite on every insert path,
    // atomically with the insert itself.
    database.exec(`
      CREATE TRIGGER api_messages_claim_abort_fence
      BEFORE INSERT ON api_messages
      WHEN EXISTS (SELECT 1 FROM runtime_topic_state
                   WHERE topic_id = NEW.topic_id AND ${CLAIM_ABORT_FENCE_PREDICATE})
      BEGIN
        SELECT RAISE(ABORT, '${TOPIC_CLAIM_ABORT_FENCE_ERROR}');
      END
    `);
    if (nodeId) {
      database.exec(
        `INSERT INTO api_node_identity (singleton, node_id, epoch_id, updated_at)
         VALUES (1, '${nodeId.replaceAll("'", "''")}', ${NEW_EPOCH_SQL}, ${NOW_SQL})
         ON CONFLICT(singleton) DO UPDATE SET node_id = excluded.node_id, updated_at = excluded.updated_at
         WHERE api_node_identity.node_id IS NOT excluded.node_id`,
      );
    }
  });
  // BEGIN IMMEDIATE when available: a migrating process waits on the busy
  // timeout for another one instead of failing its read→write upgrade.
  if (migrate.immediate) migrate.immediate();
  else migrate();
}

// After api_topics (20), api_messages (30) and runtime_topic_state (32): the
// triggers name their columns, so the tables must already have their shape.
registerStorageSchemaInitializer((database) => initializeTopicLinkRecordsSchema(database), 45);

// ── canonical payload hash ────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * sha256 (hex) of the canonical JSON of a room-creating request body without
 * the saga's own `requestId`/`payloadHash` — byte-for-byte the hub's
 * `linkPayloadHash` (otium `link/link-intents.ts`): keys sorted at every depth
 * by UTF-16 code unit, compact separators, `undefined` members dropped.
 *
 * For derive the caller passes `{ sourceTopicId: <path id>, ...body }` (the
 * same body forked from two parents must not hash equal).
 */
export function topicLinkPayloadHash(body: Record<string, unknown>): string {
  const { requestId: _requestId, payloadHash: _payloadHash, ...payload } = body;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

// ── node identity ─────────────────────────────────────────────────────────

/** Record the identity new tombstones and claims are stamped with (no-op when unchanged). */
export function recordTopicLinkNodeIdentity(nodeId: string): void {
  const id = nodeId.trim();
  if (!id) return;
  db.query(
    `INSERT INTO api_node_identity (singleton, node_id, epoch_id, updated_at)
     VALUES (1, ?, ${NEW_EPOCH_SQL}, ${NOW_SQL})
     ON CONFLICT(singleton) DO UPDATE SET node_id = excluded.node_id, updated_at = excluded.updated_at
     WHERE api_node_identity.node_id IS NOT excluded.node_id`,
  ).run(id);
}

/**
 * Random id minted when this store first recorded an identity (`dbEpoch` on
 * the wire). A wiped/recreated store answering under the same `NODE_ID` has a
 * different one; a restore of a backup of the SAME store does not (residual
 * risk, see the contract). Null until an identity is recorded.
 */
export function topicLinkDbEpoch(): string | null {
  return (
    db
      .query<{ epoch_id: string | null }, []>(
        "SELECT epoch_id FROM api_node_identity WHERE singleton = 1",
      )
      .get()?.epoch_id ?? null
  );
}

/**
 * The highest tombstone seq ever handed out (never decreases, also counts
 * rows later removed by a reshare/reinsert). A hub whose recorded cursor is
 * above this value is talking to a rolled-back store.
 */
export function topicTombstoneHighWater(): number {
  const row = db
    .query<{ seq: number | bigint }, []>(
      "SELECT seq FROM api_topic_tombstone_seq WHERE singleton = 1",
    )
    .get();
  return Number(row?.seq ?? 0);
}

/** The identity new tombstones and claims are stamped with. */
export function topicLinkNodeIdentity(): string | null {
  return (
    db
      .query<{ node_id: string }, []>("SELECT node_id FROM api_node_identity WHERE singleton = 1")
      .get()?.node_id ?? null
  );
}

// ── create claims ─────────────────────────────────────────────────────────

function toClaim(row: ClaimRow): TopicCreateClaim {
  return {
    principalKey: row.principal_key,
    requestId: row.request_id,
    op: row.op as TopicCreateClaimOp,
    payloadHash: row.payload_hash,
    topicId: row.topic_id,
    state: row.state as TopicCreateClaimState,
    nodeId: row.node_id,
    seedMaxMessageRowid: Number(row.seed_max_message_rowid ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getTopicCreateClaim(
  principalKey: string,
  requestId: string,
): TopicCreateClaim | null {
  const row = db
    .query<ClaimRow, [string, string]>(
      "SELECT * FROM api_topic_create_claims WHERE principal_key = ? AND request_id = ?",
    )
    .get(principalKey, requestId);
  return row ? toClaim(row) : null;
}

/** Committed claims of one principal, by topic id — for `hostCreate` on topic DTOs. */
export function committedClaimsByTopic(
  principalKey: string,
  topicIds?: readonly string[],
): Map<string, TopicCreateClaim> {
  const rows =
    topicIds && topicIds.length === 1
      ? db
          .query<ClaimRow, [string, string]>(
            `SELECT * FROM api_topic_create_claims
             WHERE principal_key = ? AND state = 'committed' AND topic_id = ?`,
          )
          .all(principalKey, topicIds[0] as string)
      : db
          .query<ClaimRow, [string]>(
            `SELECT * FROM api_topic_create_claims
             WHERE principal_key = ? AND state = 'committed' AND topic_id IS NOT NULL`,
          )
          .all(principalKey);
  const byTopic = new Map<string, TopicCreateClaim>();
  for (const row of rows) if (row.topic_id) byTopic.set(row.topic_id, toClaim(row));
  return byTopic;
}

function maxMessageRowid(topicId: string): number {
  const row = db
    .query<{ max_rowid: number | bigint | null }, [string]>(
      "SELECT MAX(rowid) AS max_rowid FROM api_messages WHERE topic_id = ?",
    )
    .get(topicId);
  return Number(row?.max_rowid ?? 0);
}

/**
 * Record a committed claim. MUST be called inside the transaction that inserts
 * the topic row (the `withinCreateTransaction` hook of `registerTopic` /
 * `createDerivedTopic`): a plain INSERT, so a concurrent second request with
 * the same key fails the primary key and rolls its own topic back.
 */
export function insertCommittedTopicCreateClaim(input: {
  principalKey: string;
  requestId: string;
  op: "create" | "derive";
  payloadHash: string;
  topicId: string;
}): TopicCreateClaim {
  const now = new Date().toISOString();
  const seed = maxMessageRowid(input.topicId);
  db.query(
    `INSERT INTO api_topic_create_claims
       (principal_key, request_id, op, payload_hash, topic_id, state, node_id,
        seed_max_message_rowid, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'committed', ${NODE_IDENTITY_SQL}, ?, ?, ?)`,
  ).run(
    input.principalKey,
    input.requestId,
    input.op,
    input.payloadHash,
    input.topicId,
    seed,
    now,
    now,
  );
  const claim = getTopicCreateClaim(input.principalKey, input.requestId);
  if (!claim) throw new Error("topic create claim was not recorded");
  return claim;
}

/**
 * Write the aborted fence for a key that has no claim yet, so a create that
 * arrives after the abort is refused rather than orphaned. No-op (false) when
 * any claim already exists for the key. Callers deciding "no claim" MUST do so
 * in the same transaction (see `abortTopicCreateClaim`).
 */
export function insertTopicCreateAbortFence(principalKey: string, requestId: string): boolean {
  const now = new Date().toISOString();
  const inserted = db
    .query(
      `INSERT OR IGNORE INTO api_topic_create_claims
         (principal_key, request_id, op, payload_hash, topic_id, state, node_id,
          seed_max_message_rowid, created_at, updated_at)
       VALUES (?, ?, 'abort', '', NULL, 'aborted', ${NODE_IDENTITY_SQL}, 0, ?, ?)`,
    )
    .run(principalKey, requestId, now, now);
  return Number(inserted.changes ?? 0) > 0;
}

/**
 * CAS a committed claim to aborted. Only for a caller that has decided the
 * claim's topic in the same transaction (deleted it, or found it gone): a
 * committed claim must never become aborted while its topic lives on.
 */
export function flipCommittedTopicCreateClaimToAborted(
  principalKey: string,
  requestId: string,
): boolean {
  const updated = db
    .query(
      `UPDATE api_topic_create_claims SET state = 'aborted', updated_at = ?
       WHERE principal_key = ? AND request_id = ? AND state = 'committed'`,
    )
    .run(new Date().toISOString(), principalKey, requestId);
  return Number(updated.changes ?? 0) > 0;
}

/**
 * Settle a claim as aborted where that is safe without deleting anything, in
 * one `BEGIN IMMEDIATE`: no claim → aborted fence; committed claim whose topic
 * row is already gone → aborted. A committed claim whose topic still exists is
 * returned UNCHANGED (deleting it is `abortTopicCreateClaim`'s job). Returns
 * the stored claim.
 */
export function markTopicCreateClaimAborted(
  principalKey: string,
  requestId: string,
): TopicCreateClaim {
  return db
    .transaction(() => {
      const current = getTopicCreateClaim(principalKey, requestId);
      if (!current) {
        insertTopicCreateAbortFence(principalKey, requestId);
      } else if (current.state === "committed" && !topicRowExists(current.topicId)) {
        flipCommittedTopicCreateClaimToAborted(principalKey, requestId);
      }
      const claim = getTopicCreateClaim(principalKey, requestId);
      if (!claim) throw new Error("topic create claim abort was not recorded");
      return claim;
    })
    .immediate();
}

function topicRowExists(topicId: string | null): boolean {
  if (!topicId) return false;
  return Boolean(
    db
      .query<{ found: number }, [string]>("SELECT 1 AS found FROM api_topics WHERE id = ?")
      .get(topicId),
  );
}

/** Whether a live claim-abort fence currently refuses messages into this topic. */
export function isTopicClaimAbortFenced(topicId: string): boolean {
  return Boolean(
    db
      .query<{ found: number }, [string]>(
        `SELECT 1 AS found FROM runtime_topic_state WHERE topic_id = ? AND ${CLAIM_ABORT_FENCE_PREDICATE}`,
      )
      .get(topicId),
  );
}

/** Whether an error is the message fence trigger's refusal. */
export function isTopicClaimAbortFenceError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(TOPIC_CLAIM_ABORT_FENCE_ERROR);
}

/** Messages written to a claimed topic after its creation committed. */
export function topicHasMessagesAfterClaim(claim: TopicCreateClaim): boolean {
  if (!claim.topicId) return false;
  const row = db
    .query<{ found: number }, [string, number]>(
      "SELECT 1 AS found FROM api_messages WHERE topic_id = ? AND rowid > ? LIMIT 1",
    )
    .get(claim.topicId, claim.seedMaxMessageRowid);
  return Boolean(row);
}

/** Drop claims older than the retention window. Returns the number removed. */
export function pruneTopicCreateClaims(
  now: number = Date.now(),
  retentionMs: number = TOPIC_CREATE_CLAIM_RETENTION_MS,
): number {
  const cutoff = new Date(now - retentionMs).toISOString();
  const result = db.query("DELETE FROM api_topic_create_claims WHERE created_at < ?").run(cutoff);
  return Number(result.changes ?? 0);
}

// ── tombstones ────────────────────────────────────────────────────────────

function toTombstone(row: TombstoneRow): TopicTombstone {
  return {
    seq: Number(row.seq),
    topicId: row.topic_id,
    nodeId: row.node_id,
    reason: row.reason as TopicTombstoneReason,
    surface: row.surface,
    surfaceScope: row.surface_scope,
    deletedAt: row.deleted_at,
  };
}

export function getTopicTombstone(topicId: string): TopicTombstone | null {
  const row = db
    .query<TombstoneRow, [string]>("SELECT * FROM api_topic_tombstones WHERE topic_id = ?")
    .get(topicId);
  return row ? toTombstone(row) : null;
}

/** Tombstones after a cursor, oldest first. */
export function listTopicTombstonesAfter(after: number, limit: number): TopicTombstone[] {
  return db
    .query<TombstoneRow, [number, number]>(
      "SELECT * FROM api_topic_tombstones WHERE seq > ? ORDER BY seq ASC LIMIT ?",
    )
    .all(after, limit)
    .map(toTombstone);
}
