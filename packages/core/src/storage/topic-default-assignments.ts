// Memory-persona-scoped execution defaults (model + effort) chosen by the
// wiki archiver.
//
// Keyed by wiki memory key, never by topic id: the archiver often runs while
// the room it distilled is being deleted, and `deleteTopicCascade` drops that
// room's `api_topic_brief` row right after launching the fire-and-forget
// archiver turn. A memory-key-scoped row therefore outlives the room, and a
// later room created for the same persona can pick the assignment back up
// without any settlement handshake between delete and archive.
import { db } from "#storage/forum-db";
import { registerStorageSchemaInitializer } from "#storage/storage-host";
import { wikiSummarySlug } from "#storage/wiki-summary-names";

registerStorageSchemaInitializer((database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS topic_default_assignments (
      memory_key TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      effort TEXT,
      reason TEXT,
      assign_count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}, 31);

export interface TopicDefaultAssignment {
  /** Normalized wiki memory key this assignment applies to. */
  memoryKey: string;
  /** Model id as assigned; the agent is derived from it, never stored. */
  model: string;
  /** Reasoning effort, or undefined to use the node's fixed default. */
  effort?: string;
  /** Why the archiver chose this pairing — doubles as the audit trail. */
  reason?: string;
  /** How many times an archiver run has written this row. */
  assignCount: number;
  updatedAt: string;
}

interface AssignmentRow {
  memory_key: string;
  model: string;
  effort: string | null;
  reason: string | null;
  assign_count: number;
  updated_at: string;
}

/**
 * Normalize a memory key the same way wiki topic documents are slugged.
 * Returns "" for a blank key: `wikiSummarySlug` maps empty input to its "_"
 * placeholder, which would file every unnamed persona in one shared bucket.
 */
export function normalizeMemoryKey(memoryKey: string): string {
  const raw = memoryKey
    .trim()
    .replace(/^topic\//, "")
    .replace(/\.md$/i, "")
    .trim();
  if (!raw) return "";
  return wikiSummarySlug(raw).toLowerCase();
}

function rowToAssignment(row: AssignmentRow): TopicDefaultAssignment {
  return {
    memoryKey: row.memory_key,
    model: row.model,
    effort: row.effort ?? undefined,
    reason: row.reason ?? undefined,
    assignCount: row.assign_count,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = "memory_key, model, effort, reason, assign_count, updated_at";

export function getTopicDefaultAssignment(memoryKey: string): TopicDefaultAssignment | null {
  const key = normalizeMemoryKey(memoryKey);
  if (!key) return null;
  const row = db
    .query(`SELECT ${SELECT_COLUMNS} FROM topic_default_assignments WHERE memory_key = ?`)
    .get(key) as AssignmentRow | null;
  return row ? rowToAssignment(row) : null;
}

export interface UpsertTopicDefaultAssignmentInput {
  memoryKey: string;
  model: string;
  effort?: string;
  reason?: string;
}

/**
 * Write (or overwrite) the assignment for a memory key. `assign_count` keeps
 * incrementing so an archiver that keeps re-deciding is visible in the data
 * itself — no separate audit log exists or is needed.
 */
export function upsertTopicDefaultAssignment(
  input: UpsertTopicDefaultAssignmentInput,
): TopicDefaultAssignment | null {
  const key = normalizeMemoryKey(input.memoryKey);
  const model = input.model.trim();
  if (!key || !model) return null;
  db.query(
    `INSERT INTO topic_default_assignments (memory_key, model, effort, reason, assign_count, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(memory_key) DO UPDATE SET
       model = excluded.model,
       effort = excluded.effort,
       reason = excluded.reason,
       assign_count = topic_default_assignments.assign_count + 1,
       updated_at = excluded.updated_at`,
  ).run(
    key,
    model,
    input.effort?.trim() || null,
    input.reason?.trim() || null,
    new Date().toISOString(),
  );
  return getTopicDefaultAssignment(key);
}

export function deleteTopicDefaultAssignment(memoryKey: string): boolean {
  const key = normalizeMemoryKey(memoryKey);
  if (!key) return false;
  const before = getTopicDefaultAssignment(key);
  if (!before) return false;
  db.query("DELETE FROM topic_default_assignments WHERE memory_key = ?").run(key);
  return true;
}

export function listTopicDefaultAssignments(limit = 100): TopicDefaultAssignment[] {
  const rows = db
    .query(
      `SELECT ${SELECT_COLUMNS} FROM topic_default_assignments ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 1000))) as AssignmentRow[];
  return rows.map(rowToAssignment);
}
