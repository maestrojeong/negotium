import { db } from "#storage/forum-db";
import { registerStorageSchemaInitializer } from "#storage/storage-host";

registerStorageSchemaInitializer((database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_topic_archive_state (
      topic_id TEXT PRIMARY KEY,
      last_archived_rowid INTEGER NOT NULL DEFAULT 0,
      last_archive_path TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}, 30);

export interface TopicArchiveState {
  topicId: string;
  lastArchivedRowid: number;
  lastArchivePath?: string;
  updatedAt: string;
}

interface TopicArchiveStateRow {
  topic_id: string;
  last_archived_rowid: number;
  last_archive_path: string | null;
  updated_at: string;
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

/** Remove the idle-archive cursor for a topic that no longer exists. */
export function deleteTopicArchiveState(topicId: string): boolean {
  return (
    db.query("DELETE FROM api_topic_archive_state WHERE topic_id = ?").run(topicId).changes > 0
  );
}
