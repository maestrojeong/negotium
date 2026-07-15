import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";
import { TURN_LEASE_STALE_MS } from "#storage/runtime-leases";
import { TOPIC_MAINTENANCE_STALE_MS } from "#storage/runtime-topic-state";

export type SelfScheduleStatus = "pending" | "running";

export interface SelfSchedule {
  id: string;
  topicId: string;
  userId: string;
  message: string;
  deliverAt: number;
  createdAt: number;
  updatedAt: number;
  status: SelfScheduleStatus;
  claimedBy?: string;
  claimedAt?: number;
  runningQueryId?: string;
}

interface SelfScheduleRow {
  id: string;
  topic_id: string;
  user_id: string;
  message: string;
  deliver_at: number | bigint;
  created_at: number | bigint;
  updated_at: number | bigint;
  status: string;
  claimed_by: string | null;
  claimed_at: number | bigint | null;
  running_query_id: string | null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_self_schedules (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    deliver_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running')),
    claimed_by TEXT,
    claimed_at INTEGER,
    running_query_id TEXT
  )
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_self_schedules_one_pending
  ON runtime_self_schedules(topic_id)
  WHERE status = 'pending'
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_runtime_self_schedules_due
  ON runtime_self_schedules(status, deliver_at)
`);

function rowToSchedule(row: SelfScheduleRow): SelfSchedule {
  return {
    id: row.id,
    topicId: row.topic_id,
    userId: row.user_id,
    message: row.message,
    deliverAt: Number(row.deliver_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    status: row.status === "running" ? "running" : "pending",
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at === null ? undefined : Number(row.claimed_at),
    runningQueryId: row.running_query_id ?? undefined,
  };
}

export type CreatePendingSelfScheduleResult =
  | { ok: true; schedule: SelfSchedule }
  | { ok: false; existing: SelfSchedule };

/** Create the topic's sole pending self-schedule without replacing an existing one. */
export function createPendingSelfSchedule(input: {
  topicId: string;
  userId: string;
  message: string;
  deliverAt: number;
  now?: number;
}): CreatePendingSelfScheduleResult {
  return db
    .transaction(() => {
      const existing = getPendingSelfSchedule(input.topicId);
      if (existing) return { ok: false as const, existing };

      const now = input.now ?? Date.now();
      const schedule: SelfSchedule = {
        id: `scheduled-${randomUUID()}`,
        topicId: input.topicId,
        userId: input.userId,
        message: input.message,
        deliverAt: input.deliverAt,
        createdAt: now,
        updatedAt: now,
        status: "pending",
      };
      db.query(
        `INSERT INTO runtime_self_schedules
           (id, topic_id, user_id, message, deliver_at, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        schedule.id,
        schedule.topicId,
        schedule.userId,
        schedule.message,
        schedule.deliverAt,
        schedule.createdAt,
        schedule.updatedAt,
      );
      return { ok: true as const, schedule };
    })
    .immediate();
}

export function getPendingSelfSchedule(topicId: string): SelfSchedule | null {
  const row = db
    .query<SelfScheduleRow, [string]>(
      "SELECT * FROM runtime_self_schedules WHERE topic_id = ? AND status = 'pending'",
    )
    .get(topicId);
  return row ? rowToSchedule(row) : null;
}

export function updatePendingSelfSchedule(input: {
  topicId: string;
  scheduleId: string;
  message?: string;
  deliverAt?: number;
  now?: number;
}): SelfSchedule | null {
  const existing = getPendingSelfSchedule(input.topicId);
  if (!existing || existing.id !== input.scheduleId) return null;
  const result = db
    .query(
      `UPDATE runtime_self_schedules
       SET message = ?, deliver_at = ?, updated_at = ?
       WHERE id = ? AND topic_id = ? AND status = 'pending'`,
    )
    .run(
      input.message ?? existing.message,
      input.deliverAt ?? existing.deliverAt,
      input.now ?? Date.now(),
      input.scheduleId,
      input.topicId,
    );
  return Number(result.changes ?? 0) > 0 ? getPendingSelfSchedule(input.topicId) : null;
}

export function cancelPendingSelfSchedule(topicId: string, scheduleId: string): boolean {
  const result = db
    .query(
      "DELETE FROM runtime_self_schedules WHERE id = ? AND topic_id = ? AND status = 'pending'",
    )
    .run(scheduleId, topicId);
  return Number(result.changes ?? 0) > 0;
}

/**
 * Claim one due schedule whose topic is idle. A stale running row is retryable
 * after its process and topic lease disappear, preserving work across crashes.
 */
export function claimNextDueSelfSchedule(ownerId: string, now = Date.now()): SelfSchedule | null {
  const staleBefore = now - TURN_LEASE_STALE_MS;
  return db
    .transaction(() => {
      const row = db
        .query<SelfScheduleRow, [number, number, number, number]>(
          `SELECT s.*
           FROM runtime_self_schedules s
           LEFT JOIN runtime_turn_leases l ON l.topic_id = s.topic_id
           LEFT JOIN runtime_topic_state t ON t.topic_id = s.topic_id
           WHERE (l.topic_id IS NULL OR l.heartbeat_at < ?)
             AND (t.topic_id IS NULL OR t.maintenance = 0 OR t.heartbeat_at < ?)
             AND (
               (s.status = 'pending' AND s.deliver_at <= ?)
               OR (s.status = 'running' AND (s.claimed_at IS NULL OR s.claimed_at < ?))
             )
           ORDER BY CASE s.status WHEN 'running' THEN 0 ELSE 1 END, s.deliver_at ASC
           LIMIT 1`,
        )
        .get(staleBefore, now - TOPIC_MAINTENANCE_STALE_MS, now, staleBefore);
      if (!row) return null;

      const result = db
        .query(
          `UPDATE runtime_self_schedules
           SET status = 'running', claimed_by = ?, claimed_at = ?, running_query_id = NULL
           WHERE id = ? AND (
             (status = 'pending' AND deliver_at <= ?)
             OR (status = 'running' AND (claimed_at IS NULL OR claimed_at < ?))
           )`,
        )
        .run(ownerId, now, row.id, now, staleBefore);
      if (Number(result.changes ?? 0) === 0) return null;
      return rowToSchedule({
        ...row,
        status: "running",
        claimed_by: ownerId,
        claimed_at: now,
        running_query_id: null,
      });
    })
    .immediate();
}

export function markSelfScheduleRunning(
  scheduleId: string,
  ownerId: string,
  queryId: string,
): boolean {
  const result = db
    .query(
      `UPDATE runtime_self_schedules
       SET running_query_id = ?, claimed_at = ?
       WHERE id = ? AND status = 'running' AND claimed_by = ?`,
    )
    .run(queryId, Date.now(), scheduleId, ownerId);
  return Number(result.changes ?? 0) > 0;
}

export function heartbeatSelfScheduleClaim(
  scheduleId: string,
  ownerId: string,
  now = Date.now(),
): boolean {
  const result = db
    .query(
      `UPDATE runtime_self_schedules
       SET claimed_at = ?
       WHERE id = ? AND status = 'running' AND claimed_by = ?`,
    )
    .run(now, scheduleId, ownerId);
  return Number(result.changes ?? 0) > 0;
}

/**
 * Put an interrupted run back into the single pending slot. If its own turn
 * already created a newer pending schedule, the newer explicit schedule wins.
 */
export function releaseSelfScheduleClaim(
  scheduleId: string,
  ownerId: string,
): "released" | "dropped" {
  return db
    .transaction(() => {
      const row = db
        .query<SelfScheduleRow, [string, string]>(
          "SELECT * FROM runtime_self_schedules WHERE id = ? AND status = 'running' AND claimed_by = ?",
        )
        .get(scheduleId, ownerId);
      if (!row) return "dropped" as const;
      const newer = getPendingSelfSchedule(row.topic_id);
      if (newer) {
        db.query("DELETE FROM runtime_self_schedules WHERE id = ?").run(scheduleId);
        return "dropped" as const;
      }
      db.query(
        `UPDATE runtime_self_schedules
         SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
             running_query_id = NULL, updated_at = ?
         WHERE id = ? AND claimed_by = ?`,
      ).run(Date.now(), scheduleId, ownerId);
      return "released" as const;
    })
    .immediate();
}

export function completeSelfSchedule(scheduleId: string, ownerId?: string): boolean {
  const result = ownerId
    ? db
        .query("DELETE FROM runtime_self_schedules WHERE id = ? AND claimed_by = ?")
        .run(scheduleId, ownerId)
    : db.query("DELETE FROM runtime_self_schedules WHERE id = ?").run(scheduleId);
  return Number(result.changes ?? 0) > 0;
}

export function deleteSelfSchedulesForTopic(topicId: string): number {
  const result = db.query("DELETE FROM runtime_self_schedules WHERE topic_id = ?").run(topicId);
  return Number(result.changes ?? 0);
}

/** Test/diagnostic helper covering pending and in-flight rows. */
export function listSelfSchedulesForTopic(topicId: string): SelfSchedule[] {
  return db
    .query<SelfScheduleRow, [string]>(
      "SELECT * FROM runtime_self_schedules WHERE topic_id = ? ORDER BY deliver_at, created_at",
    )
    .all(topicId)
    .map(rowToSchedule);
}
