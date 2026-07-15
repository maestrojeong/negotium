import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";

export const TOPIC_MAINTENANCE_STALE_MS = 30_000;
export const TOPIC_MAINTENANCE_HEARTBEAT_MS = 1_000;

export interface RuntimeTopicState {
  topicId: string;
  epoch: number;
  maintenance: boolean;
  maintenanceOwner?: string;
  heartbeatAt?: number;
}

export interface RuntimeTopicMaintenanceHandle {
  topicId: string;
  epoch: number;
  ownerId: string;
  isOwned(): boolean;
  finish(options?: { deleteState?: boolean }): void;
}

interface RuntimeTopicStateRow {
  topic_id: string;
  epoch: number | bigint;
  maintenance: number;
  maintenance_owner: string | null;
  heartbeat_at: number | bigint | null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_topic_state (
    topic_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL DEFAULT 0,
    maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)),
    maintenance_owner TEXT,
    heartbeat_at INTEGER
  )
`);

function rowToState(row: RuntimeTopicStateRow, now = Date.now()): RuntimeTopicState {
  const heartbeatAt = row.heartbeat_at === null ? undefined : Number(row.heartbeat_at);
  const maintenance =
    row.maintenance !== 0 &&
    heartbeatAt !== undefined &&
    now - heartbeatAt <= TOPIC_MAINTENANCE_STALE_MS;
  return {
    topicId: row.topic_id,
    epoch: Number(row.epoch),
    maintenance,
    maintenanceOwner: maintenance ? (row.maintenance_owner ?? undefined) : undefined,
    heartbeatAt,
  };
}

export function getRuntimeTopicState(topicId: string, now = Date.now()): RuntimeTopicState {
  const row = db
    .query<RuntimeTopicStateRow, [string]>("SELECT * FROM runtime_topic_state WHERE topic_id = ?")
    .get(topicId);
  return row ? rowToState(row, now) : { topicId, epoch: 0, maintenance: false };
}

export function getRuntimeTopicEpoch(topicId: string): number {
  return getRuntimeTopicState(topicId).epoch;
}

export function isRuntimeTopicMaintenance(topicId: string, now = Date.now()): boolean {
  return getRuntimeTopicState(topicId, now).maintenance;
}

/**
 * Advance the topic execution epoch and hold an exclusive maintenance fence.
 * Turns from an older epoch can be identified and discarded in every process.
 */
export function beginRuntimeTopicMaintenance(
  topicId: string,
  options: { ownerId?: string; now?: number; heartbeatMs?: number } = {},
): RuntimeTopicMaintenanceHandle | null {
  const ownerId = options.ownerId ?? `${process.pid}-${randomUUID()}`;
  const now = options.now ?? Date.now();
  const result = db
    .query(
      `INSERT INTO runtime_topic_state
         (topic_id, epoch, maintenance, maintenance_owner, heartbeat_at)
       VALUES (?, 1, 1, ?, ?)
       ON CONFLICT(topic_id) DO UPDATE SET
         epoch = runtime_topic_state.epoch + 1,
         maintenance = 1,
         maintenance_owner = excluded.maintenance_owner,
         heartbeat_at = excluded.heartbeat_at
       WHERE runtime_topic_state.maintenance = 0
          OR runtime_topic_state.heartbeat_at IS NULL
          OR runtime_topic_state.heartbeat_at < ?`,
    )
    .run(topicId, ownerId, now, now - TOPIC_MAINTENANCE_STALE_MS);
  if (Number(result.changes ?? 0) === 0) return null;

  const epoch = getRuntimeTopicEpoch(topicId);
  let finished = false;
  const heartbeatMs = options.heartbeatMs ?? TOPIC_MAINTENANCE_HEARTBEAT_MS;
  const timer = setInterval(() => {
    if (finished) return;
    const updated = db
      .query(
        `UPDATE runtime_topic_state
         SET heartbeat_at = ?
         WHERE topic_id = ? AND epoch = ? AND maintenance_owner = ? AND maintenance = 1`,
      )
      .run(Date.now(), topicId, epoch, ownerId);
    if (Number(updated.changes ?? 0) > 0) return;
    finished = true;
    clearInterval(timer);
  }, heartbeatMs);
  timer.unref?.();

  return {
    topicId,
    epoch,
    ownerId,
    isOwned() {
      if (finished) return false;
      const row = db
        .query<{ owned: number }, [string, number, string]>(
          `SELECT 1 AS owned FROM runtime_topic_state
           WHERE topic_id = ? AND epoch = ? AND maintenance_owner = ? AND maintenance = 1`,
        )
        .get(topicId, epoch, ownerId);
      return Boolean(row);
    },
    finish(finishOptions = {}) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (finishOptions.deleteState) {
        db.query(
          `DELETE FROM runtime_topic_state
           WHERE topic_id = ? AND epoch = ? AND maintenance_owner = ?`,
        ).run(topicId, epoch, ownerId);
        return;
      }
      db.query(
        `UPDATE runtime_topic_state
         SET maintenance = 0, maintenance_owner = NULL, heartbeat_at = NULL
         WHERE topic_id = ? AND epoch = ? AND maintenance_owner = ?`,
      ).run(topicId, epoch, ownerId);
    },
  };
}
