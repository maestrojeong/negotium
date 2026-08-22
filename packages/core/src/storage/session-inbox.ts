import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";
import { notifySessionInboxWrite } from "#storage/session-inbox-signal";
import { registerStorageSchemaInitializer } from "#storage/storage-host";

export interface SessionInboxRow {
  sequence: number;
  id: string;
  userId: string;
  topicId: string;
  payload: string;
  createdAt: number;
}

interface SessionInboxDatabaseRow {
  sequence: number | bigint;
  id: string;
  user_id: string;
  topic_id: string;
  payload: string;
  created_at: number | bigint;
}

export interface SessionInboxTopic {
  userId: string;
  topicId: string;
}

registerStorageSchemaInitializer((database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_inbox (
      sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
      id          TEXT NOT NULL UNIQUE,
      user_id     TEXT NOT NULL,
      topic_id    TEXT NOT NULL,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing')),
      claimed_by  TEXT,
      claimed_at  INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_inbox_ready
      ON session_inbox(status, user_id, topic_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_session_inbox_topic
      ON session_inbox(topic_id);
  `);
}, 35);

function toRow(row: SessionInboxDatabaseRow): SessionInboxRow {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    userId: row.user_id,
    topicId: row.topic_id,
    payload: row.payload,
    createdAt: Number(row.created_at),
  };
}

/** Durable enqueue. Callers may wrap this in a wider transaction. */
export function enqueueSessionInbox(args: {
  userId: string;
  topicId: string;
  entry: unknown;
  id?: string;
  createdAt?: number;
}): { id: string; inserted: boolean } {
  const id = args.id ?? randomUUID();
  const result = db
    .query(
      `INSERT OR IGNORE INTO session_inbox
         (id, user_id, topic_id, payload, status, claimed_by, claimed_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
    )
    .run(id, args.userId, args.topicId, JSON.stringify(args.entry), args.createdAt ?? Date.now());
  const inserted = Number(result.changes ?? 0) === 1;
  // Wake the elected worker instead of leaving the row for the next poll tick.
  if (inserted) notifySessionInboxWrite();
  return { id, inserted };
}

export function listPendingSessionInboxTopics(): SessionInboxTopic[] {
  return db
    .query<{ user_id: string; topic_id: string }, []>(
      `SELECT user_id, topic_id
       FROM session_inbox
       WHERE status = 'pending'
       GROUP BY user_id, topic_id
       ORDER BY MIN(sequence)`,
    )
    .all()
    .map((row) => ({ userId: row.user_id, topicId: row.topic_id }));
}

/** Atomically reserve one FIFO batch for the elected worker. */
export function claimSessionInboxBatch(args: {
  userId: string;
  topicId: string;
  ownerId: string;
  limit?: number;
}): SessionInboxRow[] {
  return db
    .transaction(() => {
      const rows = db
        .query<SessionInboxDatabaseRow, [string, string, number]>(
          `SELECT sequence, id, user_id, topic_id, payload, created_at
         FROM session_inbox
         WHERE status = 'pending' AND user_id = ? AND topic_id = ?
         ORDER BY sequence
         LIMIT ?`,
        )
        .all(args.userId, args.topicId, args.limit ?? 100);
      if (rows.length === 0) return [];
      const sequences = rows.map((row) => Number(row.sequence));
      db.query(
        `UPDATE session_inbox
       SET status = 'processing', claimed_by = ?, claimed_at = ?
       WHERE status = 'pending' AND sequence IN (${sequences.map(() => "?").join(",")})`,
      ).run(args.ownerId, Date.now(), ...sequences);
      return rows.map(toRow);
    })
    .immediate();
}

export function completeSessionInboxBatch(ids: string[], ownerId: string): number {
  if (ids.length === 0) return 0;
  const result = db
    .query(
      `DELETE FROM session_inbox
       WHERE claimed_by = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .run(ownerId, ...ids);
  return Number(result.changes ?? 0);
}

export function releaseSessionInboxBatch(ids: string[], ownerId: string): number {
  if (ids.length === 0) return 0;
  const result = db
    .query(
      `UPDATE session_inbox
       SET status = 'pending', claimed_by = NULL, claimed_at = NULL
       WHERE claimed_by = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
    .run(ownerId, ...ids);
  return Number(result.changes ?? 0);
}

/** The process lease guarantees no live previous owner when leadership changes. */
export function recoverSessionInboxClaims(): number {
  const result = db.run(
    `UPDATE session_inbox
     SET status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE status = 'processing'`,
  );
  return Number(result.changes ?? 0);
}

export function deleteSessionInboxForTopic(topicId: string): number {
  return Number(db.run("DELETE FROM session_inbox WHERE topic_id = ?", [topicId]).changes ?? 0);
}
