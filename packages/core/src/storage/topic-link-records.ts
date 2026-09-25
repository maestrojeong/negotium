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
import { db } from "#storage/forum-db";
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
const NEXT_TOMBSTONE_SEQ_SQL = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM api_topic_tombstones)";

/**
 * Idempotent, and all-or-nothing: every statement is `IF NOT EXISTS` / an
 * upsert, and the whole set runs in one transaction so a crash half-way never
 * leaves triggers without the table they write to.
 */
export function initializeTopicLinkRecordsSchema(
  database: { exec(sql: string): unknown; transaction<T>(fn: () => T): () => T },
  nodeId?: string,
): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS api_node_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        node_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
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
    // Hard delete, from any writer. `DROP TABLE` (the legacy schema rebuild)
    // does not fire row triggers, so a migration never fabricates tombstones.
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS api_topics_tombstone_on_delete
      AFTER DELETE ON api_topics
      BEGIN
        INSERT OR REPLACE INTO api_topic_tombstones
          (topic_id, seq, node_id, reason, surface, surface_scope, deleted_at)
        VALUES
          (OLD.id, ${NEXT_TOMBSTONE_SEQ_SQL}, ${NODE_IDENTITY_SQL}, 'deleted',
           OLD.surface, OLD.surface_scope, ${NOW_SQL});
      END
    `);
    // Left the Otium surface (moved to another surface or hidden). Evidence of
    // a withdrawal, never of a deletion: the existence API still answers
    // `present` for such a topic.
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS api_topics_tombstone_on_unshare
      AFTER UPDATE OF surface, visibility ON api_topics
      WHEN OLD.surface = 'otium' AND COALESCE(OLD.visibility, 'visible') != 'hidden'
        AND (NEW.surface IS NOT 'otium' OR NEW.visibility = 'hidden')
      BEGIN
        INSERT OR REPLACE INTO api_topic_tombstones
          (topic_id, seq, node_id, reason, surface, surface_scope, deleted_at)
        VALUES
          (OLD.id, ${NEXT_TOMBSTONE_SEQ_SQL}, ${NODE_IDENTITY_SQL}, 'unshared',
           OLD.surface, OLD.surface_scope, ${NOW_SQL});
      END
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS api_topics_tombstone_on_reshare
      AFTER UPDATE OF surface, visibility ON api_topics
      WHEN NEW.surface = 'otium' AND COALESCE(NEW.visibility, 'visible') != 'hidden'
      BEGIN
        DELETE FROM api_topic_tombstones WHERE topic_id = NEW.id AND reason = 'unshared';
      END
    `);
    // A row that exists again (restored or re-inserted id) is not gone.
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS api_topics_tombstone_on_insert
      AFTER INSERT ON api_topics
      BEGIN
        DELETE FROM api_topic_tombstones WHERE topic_id = NEW.id;
      END
    `);
    if (nodeId) {
      database.exec(
        `INSERT INTO api_node_identity (singleton, node_id, updated_at) VALUES (1, '${nodeId.replaceAll("'", "''")}', ${NOW_SQL})
         ON CONFLICT(singleton) DO UPDATE SET node_id = excluded.node_id, updated_at = excluded.updated_at
         WHERE api_node_identity.node_id IS NOT excluded.node_id`,
      );
    }
  })();
}

// After api_topics (20) and api_messages (30): the triggers name api_topics
// columns, so the table must already have its current shape.
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
    `INSERT INTO api_node_identity (singleton, node_id, updated_at) VALUES (1, ?, ${NOW_SQL})
     ON CONFLICT(singleton) DO UPDATE SET node_id = excluded.node_id, updated_at = excluded.updated_at
     WHERE api_node_identity.node_id IS NOT excluded.node_id`,
  ).run(id);
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
 * Settle a claim as aborted: an existing committed claim flips (CAS on its
 * state), a missing one becomes an aborted tombstone so a create that arrives
 * after the abort is refused rather than orphaned. Returns the stored claim.
 */
export function markTopicCreateClaimAborted(
  principalKey: string,
  requestId: string,
): TopicCreateClaim {
  const now = new Date().toISOString();
  db.transaction(() => {
    const updated = db
      .query(
        `UPDATE api_topic_create_claims SET state = 'aborted', updated_at = ?
         WHERE principal_key = ? AND request_id = ? AND state = 'committed'`,
      )
      .run(now, principalKey, requestId);
    if (Number(updated.changes ?? 0) > 0) return;
    db.query(
      `INSERT OR IGNORE INTO api_topic_create_claims
         (principal_key, request_id, op, payload_hash, topic_id, state, node_id,
          seed_max_message_rowid, created_at, updated_at)
       VALUES (?, ?, 'abort', '', NULL, 'aborted', ${NODE_IDENTITY_SQL}, 0, ?, ?)`,
    ).run(principalKey, requestId, now, now);
  })();
  const claim = getTopicCreateClaim(principalKey, requestId);
  if (!claim) throw new Error("topic create claim abort was not recorded");
  return claim;
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
