import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";
import { TOPIC_MAINTENANCE_STALE_MS } from "#storage/runtime-topic-state";

export const RUNTIME_INSTANCE_ID = `${process.pid}-${randomUUID()}`;
export const TURN_LEASE_STALE_MS = 10_000;

export interface RuntimeTurnLease {
  topicId: string;
  queryId: string;
  ownerId: string;
  origin: string;
  startedAt: number;
  heartbeatAt: number;
  abortRequested: boolean;
  abortReason?: "internal" | "external";
}

interface RuntimeTurnLeaseRow {
  topic_id: string;
  query_id: string;
  owner_id: string;
  origin: string;
  started_at: number | bigint;
  heartbeat_at: number | bigint;
  abort_requested: number;
  abort_reason: string | null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_turn_leases (
    topic_id TEXT PRIMARY KEY,
    query_id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    abort_requested INTEGER NOT NULL DEFAULT 0 CHECK (abort_requested IN (0, 1)),
    abort_reason TEXT CHECK (abort_reason IS NULL OR abort_reason IN ('internal', 'external'))
  )
`);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_runtime_turn_leases_heartbeat ON runtime_turn_leases(heartbeat_at)",
);

function rowToLease(row: RuntimeTurnLeaseRow): RuntimeTurnLease {
  const abortReason =
    row.abort_reason === "internal" || row.abort_reason === "external"
      ? row.abort_reason
      : undefined;
  return {
    topicId: row.topic_id,
    queryId: row.query_id,
    ownerId: row.owner_id,
    origin: row.origin,
    startedAt: Number(row.started_at),
    heartbeatAt: Number(row.heartbeat_at),
    abortRequested: row.abort_requested !== 0,
    abortReason,
  };
}

export function getRuntimeTurnLease(topicId: string, now = Date.now()): RuntimeTurnLease | null {
  const row = db
    .query<RuntimeTurnLeaseRow, [string]>("SELECT * FROM runtime_turn_leases WHERE topic_id = ?")
    .get(topicId);
  if (!row) return null;
  const lease = rowToLease(row);
  return now - lease.heartbeatAt <= TURN_LEASE_STALE_MS ? lease : null;
}

export function listRuntimeTurnLeases(now = Date.now()): RuntimeTurnLease[] {
  return db
    .query<RuntimeTurnLeaseRow, []>("SELECT * FROM runtime_turn_leases ORDER BY started_at ASC")
    .all()
    .map(rowToLease)
    .filter((lease) => now - lease.heartbeatAt <= TURN_LEASE_STALE_MS);
}

export function claimRuntimeTurnLease(
  input: {
    topicId: string;
    queryId: string;
    origin: string;
    ownerId?: string;
  },
  now = Date.now(),
): boolean {
  const ownerId = input.ownerId ?? RUNTIME_INSTANCE_ID;
  const result = db
    .query(
      `INSERT INTO runtime_turn_leases
         (topic_id, query_id, owner_id, origin, started_at, heartbeat_at, abort_requested, abort_reason)
       SELECT ?, ?, ?, ?, ?, ?, 0, NULL
       WHERE NOT EXISTS (
         SELECT 1 FROM runtime_topic_state
         WHERE topic_id = ? AND maintenance = 1 AND heartbeat_at >= ?
       )
       ON CONFLICT(topic_id) DO UPDATE SET
         query_id = excluded.query_id,
         owner_id = excluded.owner_id,
         origin = excluded.origin,
         started_at = excluded.started_at,
         heartbeat_at = excluded.heartbeat_at,
         abort_requested = 0,
         abort_reason = NULL
       WHERE (runtime_turn_leases.owner_id = excluded.owner_id
          OR runtime_turn_leases.heartbeat_at < ?)
         AND NOT EXISTS (
           SELECT 1 FROM runtime_topic_state
           WHERE topic_id = excluded.topic_id AND maintenance = 1 AND heartbeat_at >= ?
         )`,
    )
    .run(
      input.topicId,
      input.queryId,
      ownerId,
      input.origin,
      now,
      now,
      input.topicId,
      now - TOPIC_MAINTENANCE_STALE_MS,
      now - TURN_LEASE_STALE_MS,
      now - TOPIC_MAINTENANCE_STALE_MS,
    );
  return Number(result.changes ?? 0) > 0;
}

export function heartbeatRuntimeTurnLease(
  topicId: string,
  queryId: string,
  ownerId = RUNTIME_INSTANCE_ID,
  now = Date.now(),
): { owned: boolean; abortRequested: boolean; abortReason?: "internal" | "external" } {
  const updated = db
    .query(
      `UPDATE runtime_turn_leases
       SET heartbeat_at = ?
       WHERE topic_id = ? AND query_id = ? AND owner_id = ?`,
    )
    .run(now, topicId, queryId, ownerId);
  if (Number(updated.changes ?? 0) === 0) return { owned: false, abortRequested: false };

  const row = db
    .query<{ abort_requested: number; abort_reason: string | null }, [string, string, string]>(
      `SELECT abort_requested, abort_reason
       FROM runtime_turn_leases
       WHERE topic_id = ? AND query_id = ? AND owner_id = ?`,
    )
    .get(topicId, queryId, ownerId);
  const abortReason =
    row?.abort_reason === "internal" || row?.abort_reason === "external"
      ? row.abort_reason
      : undefined;
  return {
    owned: Boolean(row),
    abortRequested: row?.abort_requested !== 0,
    abortReason,
  };
}

export function requestRuntimeTurnAbort(topicId: string, reason: "internal" | "external"): boolean {
  const result = db
    .query(
      `UPDATE runtime_turn_leases
       SET abort_requested = 1,
           abort_reason = CASE
             WHEN abort_reason = 'external' THEN abort_reason
             ELSE ?
           END
       WHERE topic_id = ? AND heartbeat_at >= ?`,
    )
    .run(reason, topicId, Date.now() - TURN_LEASE_STALE_MS);
  return Number(result.changes ?? 0) > 0;
}

export function releaseRuntimeTurnLease(
  topicId: string,
  queryId: string,
  ownerId = RUNTIME_INSTANCE_ID,
): boolean {
  const result = db
    .query(
      `DELETE FROM runtime_turn_leases
       WHERE topic_id = ? AND query_id = ? AND owner_id = ?`,
    )
    .run(topicId, queryId, ownerId);
  return Number(result.changes ?? 0) > 0;
}
