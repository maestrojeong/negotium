import { rmSync } from "node:fs";
import { db } from "#storage/forum-db";
import { registerStorageSchemaInitializer } from "#storage/storage-host";

registerStorageSchemaInitializer((database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_topic_archive_state (
      topic_id TEXT PRIMARY KEY,
      last_archived_rowid INTEGER NOT NULL DEFAULT 0,
      last_archive_path TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_topic_archive_jobs (
      topic_id TEXT PRIMARY KEY,
      after_rowid INTEGER NOT NULL,
      last_rowid INTEGER NOT NULL,
      archive_path TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'pending')),
      updated_at TEXT NOT NULL
    );
  `);
}, 30);

const ARCHIVE_JOB_STALE_MS = 30 * 60 * 1000;

export interface TopicArchiveState {
  topicId: string;
  lastArchivedRowid: number;
  lastArchivePath?: string;
  updatedAt: string;
}

export interface TopicArchiveJob {
  topicId: string;
  afterRowid: number;
  lastRowid: number;
  archivePath: string;
  messageCount: number;
  status: "running" | "pending";
  updatedAt: string;
}

export interface TopicArchiveJobCandidate {
  lastRowid: number;
  archivePath: string;
  messageCount: number;
}

interface TopicArchiveStateRow {
  topic_id: string;
  last_archived_rowid: number;
  last_archive_path: string | null;
  updated_at: string;
}

interface TopicArchiveJobRow {
  topic_id: string;
  after_rowid: number;
  last_rowid: number;
  archive_path: string;
  message_count: number;
  status: "running" | "pending";
  updated_at: string;
}

function rowToJob(row: TopicArchiveJobRow): TopicArchiveJob {
  return {
    topicId: row.topic_id,
    afterRowid: row.after_rowid,
    lastRowid: row.last_rowid,
    archivePath: row.archive_path,
    messageCount: row.message_count,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export function getTopicArchiveState(topicId: string): TopicArchiveState | null {
  const row = db.query("SELECT * FROM api_topic_archive_state WHERE topic_id = ?").get(topicId) as
    | TopicArchiveStateRow
    | undefined;
  if (!row) return null;
  return {
    topicId: row.topic_id,
    lastArchivedRowid: row.last_archived_rowid,
    lastArchivePath: row.last_archive_path ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function setTopicArchiveState(
  topicId: string,
  lastArchivedRowid: number,
  lastArchivePath?: string,
): void {
  db.query(
    `INSERT INTO api_topic_archive_state (topic_id, last_archived_rowid, last_archive_path, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(topic_id) DO UPDATE SET
       last_archived_rowid = excluded.last_archived_rowid,
       last_archive_path = excluded.last_archive_path,
       updated_at = excluded.updated_at`,
  ).run(topicId, lastArchivedRowid, lastArchivePath ?? null, new Date().toISOString());
}

/** Atomically reserve one active-topic archive job across runtime processes. */
export function claimTopicArchiveJob(
  topicId: string,
  create: (afterRowid: number) => TopicArchiveJobCandidate | null,
  now = Date.now(),
): { kind: "claimed"; job: TopicArchiveJob } | { kind: "busy" } | null {
  const claimExisting = () =>
    db.transaction(() => {
      const existing = db
        .query<TopicArchiveJobRow, [string]>(
          "SELECT * FROM api_topic_archive_jobs WHERE topic_id = ?",
        )
        .get(topicId);
      if (!existing) return null;
      const updatedAt = Date.parse(existing.updated_at);
      if (
        existing.status === "running" &&
        Number.isFinite(updatedAt) &&
        now - updatedAt < ARCHIVE_JOB_STALE_MS
      ) {
        return { kind: "busy" } as const;
      }
      const timestamp = new Date(now).toISOString();
      db.query(
        "UPDATE api_topic_archive_jobs SET status = 'running', updated_at = ? WHERE topic_id = ?",
      ).run(timestamp, topicId);
      return {
        kind: "claimed",
        job: rowToJob({ ...existing, status: "running", updated_at: timestamp }),
      } as const;
    })();

  const existingClaim = claimExisting();
  if (existingClaim) return existingClaim;

  // File serialization stays outside the SQLite write transaction. Only the
  // short compare-and-insert below is serialized across runtime processes.
  for (let attempt = 0; attempt < 2; attempt++) {
    const afterRowid = getTopicArchiveState(topicId)?.lastArchivedRowid ?? 0;
    const candidate = create(afterRowid);
    if (!candidate) return null;
    const result = db.transaction(() => {
      const existing = db
        .query<TopicArchiveJobRow, [string]>(
          "SELECT * FROM api_topic_archive_jobs WHERE topic_id = ?",
        )
        .get(topicId);
      if (existing) return { kind: "busy" } as const;
      const currentRowid = getTopicArchiveState(topicId)?.lastArchivedRowid ?? 0;
      if (currentRowid !== afterRowid) return { kind: "stale" } as const;
      const timestamp = new Date(now).toISOString();
      db.query(
        `INSERT INTO api_topic_archive_jobs
         (topic_id, after_rowid, last_rowid, archive_path, message_count, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      ).run(
        topicId,
        afterRowid,
        candidate.lastRowid,
        candidate.archivePath,
        candidate.messageCount,
        timestamp,
      );
      return {
        kind: "claimed",
        job: {
          topicId,
          afterRowid,
          lastRowid: candidate.lastRowid,
          archivePath: candidate.archivePath,
          messageCount: candidate.messageCount,
          status: "running",
          updatedAt: timestamp,
        },
      } as const;
    })();
    if (result.kind === "claimed") return result;
    rmSync(candidate.archivePath, { force: true });
    if (result.kind === "busy") return result;
  }
  return claimExisting() ?? { kind: "busy" };
}

/** Advance the durable cursor only after the memory turn completes. */
export function settleTopicArchiveJob(
  topicId: string,
  archivePath: string,
  success: boolean,
): void {
  db.transaction(() => {
    const job = db
      .query<TopicArchiveJobRow, [string, string]>(
        "SELECT * FROM api_topic_archive_jobs WHERE topic_id = ? AND archive_path = ?",
      )
      .get(topicId, archivePath);
    if (!job) return;
    if (!success) {
      db.query(
        "UPDATE api_topic_archive_jobs SET status = 'pending', updated_at = ? WHERE topic_id = ? AND archive_path = ?",
      ).run(new Date().toISOString(), topicId, archivePath);
      return;
    }
    const current = getTopicArchiveState(topicId)?.lastArchivedRowid ?? 0;
    setTopicArchiveState(topicId, Math.max(current, job.last_rowid), job.archive_path);
    db.query("DELETE FROM api_topic_archive_jobs WHERE topic_id = ? AND archive_path = ?").run(
      topicId,
      archivePath,
    );
  })();
}

/** Remove the idle-archive cursor for a topic that no longer exists. */
export function deleteTopicArchiveState(topicId: string): boolean {
  return db.transaction(() => {
    db.query("DELETE FROM api_topic_archive_jobs WHERE topic_id = ?").run(topicId);
    return (
      db.query("DELETE FROM api_topic_archive_state WHERE topic_id = ?").run(topicId).changes > 0
    );
  })();
}
