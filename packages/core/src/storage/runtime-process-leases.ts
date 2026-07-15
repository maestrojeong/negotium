import { db } from "#storage/forum-db";
import { RUNTIME_INSTANCE_ID } from "#storage/runtime-leases";

export const PROCESS_LEASE_STALE_MS = 5_000;
export const PROCESS_LEASE_HEARTBEAT_MS = 1_000;

export interface RuntimeProcessLease {
  role: string;
  ownerId: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface RuntimeProcessLeaseHandle extends RuntimeProcessLease {
  stop(): void;
}

interface RuntimeProcessLeaseRow {
  role: string;
  owner_id: string;
  pid: number | bigint;
  started_at: number | bigint;
  heartbeat_at: number | bigint;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_process_leases (
    role TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL UNIQUE,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  )
`);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_runtime_process_leases_heartbeat ON runtime_process_leases(heartbeat_at)",
);

function rowToLease(row: RuntimeProcessLeaseRow): RuntimeProcessLease {
  return {
    role: row.role,
    ownerId: row.owner_id,
    pid: Number(row.pid),
    startedAt: Number(row.started_at),
    heartbeatAt: Number(row.heartbeat_at),
  };
}

export function getRuntimeProcessLease(
  role: string,
  now = Date.now(),
  staleMs = PROCESS_LEASE_STALE_MS,
): RuntimeProcessLease | null {
  const row = db
    .query<RuntimeProcessLeaseRow, [string]>("SELECT * FROM runtime_process_leases WHERE role = ?")
    .get(role);
  if (!row) return null;
  const lease = rowToLease(row);
  return now - lease.heartbeatAt <= staleMs ? lease : null;
}

export function heartbeatRuntimeProcessLease(
  role: string,
  ownerId: string,
  now = Date.now(),
): boolean {
  const result = db
    .query(
      `UPDATE runtime_process_leases
       SET heartbeat_at = ?
       WHERE role = ? AND owner_id = ?`,
    )
    .run(now, role, ownerId);
  return Number(result.changes ?? 0) > 0;
}

export function releaseRuntimeProcessLease(role: string, ownerId: string): boolean {
  const result = db
    .query("DELETE FROM runtime_process_leases WHERE role = ? AND owner_id = ?")
    .run(role, ownerId);
  return Number(result.changes ?? 0) > 0;
}

/**
 * Claim one cross-process role and keep it alive with a SQLite heartbeat.
 * A process that exits without cleanup is replaceable after `staleMs`.
 */
export function acquireRuntimeProcessLease(
  role: string,
  options: {
    ownerId?: string;
    pid?: number;
    now?: number;
    staleMs?: number;
    heartbeatMs?: number;
    onLost?: () => void;
  } = {},
): RuntimeProcessLeaseHandle | null {
  const normalizedRole = role.trim();
  if (!normalizedRole) throw new Error("runtime process lease role must not be empty");
  const ownerId = options.ownerId ?? `${RUNTIME_INSTANCE_ID}:${normalizedRole}`;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? PROCESS_LEASE_STALE_MS;
  const result = db
    .query(
      `INSERT INTO runtime_process_leases (role, owner_id, pid, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(role) DO UPDATE SET
         owner_id = excluded.owner_id,
         pid = excluded.pid,
         started_at = excluded.started_at,
         heartbeat_at = excluded.heartbeat_at
       WHERE runtime_process_leases.heartbeat_at < ?`,
    )
    .run(normalizedRole, ownerId, pid, now, now, now - staleMs);
  if (Number(result.changes ?? 0) === 0) return null;

  let stopped = false;
  const heartbeatMs = options.heartbeatMs ?? PROCESS_LEASE_HEARTBEAT_MS;
  const timer = setInterval(() => {
    if (stopped) return;
    if (heartbeatRuntimeProcessLease(normalizedRole, ownerId)) return;
    stopped = true;
    clearInterval(timer);
    options.onLost?.();
  }, heartbeatMs);
  timer.unref?.();

  return {
    role: normalizedRole,
    ownerId,
    pid,
    startedAt: now,
    heartbeatAt: now,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      releaseRuntimeProcessLease(normalizedRole, ownerId);
    },
  };
}
