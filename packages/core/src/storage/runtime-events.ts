import { db } from "#storage/forum-db";

export const RUNTIME_EVENT_TYPES = [
  "message",
  "message-updated",
  "ai-status",
  "topic-created",
  "topic-updated",
  "topic-deleted",
] as const;

export type StoredRuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface StoredRuntimeEvent {
  seq: number;
  sourceId: string;
  type: StoredRuntimeEventType;
  topicId: string;
  payload: unknown;
  createdAt: string;
}

interface RuntimeEventRow {
  seq: number | bigint;
  source_id: string;
  event_type: string;
  topic_id: string;
  payload_json: string;
  created_at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
      event_type IN (
        'message',
        'message-updated',
        'ai-status',
        'topic-created',
        'topic-updated',
        'topic-deleted'
      )
    ),
    topic_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_runtime_events_topic_seq ON runtime_events(topic_id, seq)");

const types = new Set<string>(RUNTIME_EVENT_TYPES);

function rowToEvent(row: RuntimeEventRow): StoredRuntimeEvent | null {
  if (!types.has(row.event_type)) return null;
  try {
    return {
      seq: Number(row.seq),
      sourceId: row.source_id,
      type: row.event_type as StoredRuntimeEventType,
      topicId: row.topic_id,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

export function latestRuntimeEventSeq(): number {
  const row = db
    .query<{ seq: number | bigint | null }, []>("SELECT MAX(seq) AS seq FROM runtime_events")
    .get();
  return Number(row?.seq ?? 0);
}

export function appendRuntimeEvent(
  sourceId: string,
  event: {
    type: StoredRuntimeEventType;
    topicId: string;
    payload: unknown;
  },
): StoredRuntimeEvent {
  const createdAt = new Date().toISOString();
  const result = db
    .query(
      `INSERT INTO runtime_events
         (source_id, event_type, topic_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sourceId, event.type, event.topicId, JSON.stringify(event.payload ?? null), createdAt);
  const seq = Number(result.lastInsertRowid);
  return { seq, sourceId, ...event, createdAt };
}

export function listRuntimeEventsAfter(seq: number, limit = 500): StoredRuntimeEvent[] {
  const rows = db
    .query<RuntimeEventRow, [number, number]>(
      `SELECT seq, source_id, event_type, topic_id, payload_json, created_at
       FROM runtime_events
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(Math.max(0, seq), Math.max(1, Math.min(limit, 5_000)));
  return rows.map(rowToEvent).filter((event): event is StoredRuntimeEvent => event !== null);
}

/** Recent topic history used to hydrate a newly opened channel surface. */
export function listRecentRuntimeEventsForTopic(
  topicId: string,
  limit = 300,
): StoredRuntimeEvent[] {
  const rows = db
    .query<RuntimeEventRow, [string, number]>(
      `SELECT seq, source_id, event_type, topic_id, payload_json, created_at
       FROM (
         SELECT seq, source_id, event_type, topic_id, payload_json, created_at
         FROM runtime_events
         WHERE topic_id = ? AND event_type IN ('ai-status', 'message-updated')
         ORDER BY seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`,
    )
    .all(topicId, Math.max(1, Math.min(limit, 2_000)));
  return rows.map(rowToEvent).filter((event): event is StoredRuntimeEvent => event !== null);
}
