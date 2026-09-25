/**
 * Everything an `--apply` needs before its destructive transaction
 * (review findings 6 and 7):
 *
 * 1. The node must be STOPPED. There is no override flag. Offline checks
 *    (before core is loaded): no live `node-daemon.json` pid, no process lease
 *    in the DB with a live pid or a fresh heartbeat. Then, with core loaded,
 *    this process takes the `node-daemon` singleton lease itself, so no node
 *    can start while the apply runs, and re-checks that no other lease is live.
 * 2. A verified backup: `VACUUM INTO` a fresh `O_EXCL|O_NOFOLLOW` 0600 file in
 *    a private, pinned directory → fsync(file) → verify (quick_check + the
 *    caller's row checks, read with safeIntegers) → no-clobber rename to a
 *    random name → fsync(dir). Only then may anything destructive run.
 * 3. A durable operation journal row (`prepared`, with backup path/sha and
 *    report sha) committed BEFORE the destructive transaction; that
 *    transaction flips it to `committed` atomically with the change.
 */

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { ADMIN_EXIT, AdminError, errorMessage, refuse } from "./errors";
import { type SqlDb, tableExists } from "./facts";
import type { NodePaths } from "./paths";
import {
  assertSameFile,
  type FsSeam,
  openSafeDir,
  randomBasename,
  recheckSafeDir,
  type SafeDir,
} from "./safe-fs";

/** Core's PROCESS_LEASE_STALE_MS. */
export const PROCESS_LEASE_STALE_MS = 5_000;
export const NODE_DAEMON_ROLE = "node-daemon";

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** `negotium status`-equivalent + lease check, without loading core. */
export function assertNodeStoppedOffline(paths: NodePaths, db: SqlDb, now = Date.now()): void {
  if (existsSync(paths.nodeDaemonInfo)) {
    let pid: number | null = null;
    try {
      const info = JSON.parse(readFileSync(paths.nodeDaemonInfo, "utf8")) as { pid?: unknown };
      pid = typeof info.pid === "number" ? info.pid : null;
    } catch {
      refuse(
        `${paths.nodeDaemonInfo} is unreadable; cannot prove the node is stopped (run \`negotium status\`)`,
      );
    }
    if (pid === null || pidAlive(pid)) {
      refuse(
        `the node daemon is running (pid ${pid ?? "?"}, ${paths.nodeDaemonInfo}); stop it with \`negotium stop --all\` first`,
      );
    }
  }
  if (!tableExists(db, "runtime_process_leases")) return;
  const live = (
    db.query("SELECT role, pid, heartbeat_at FROM runtime_process_leases").all() as Array<{
      role: string;
      pid: number;
      heartbeat_at: number;
    }>
  ).filter(
    (lease) =>
      now - Number(lease.heartbeat_at) <= PROCESS_LEASE_STALE_MS || pidAlive(Number(lease.pid)),
  );
  if (live.length > 0) {
    refuse(
      `Negotium processes still hold this database: ${live
        .map((lease) => `${lease.role} (pid ${lease.pid})`)
        .join(", ")}. Stop them (\`negotium stop --all\`) and retry`,
    );
  }
}

export type CoreModule = typeof import("@negotium/core");

export interface CoreHandle {
  core: CoreModule;
  db: SqlDb & CoreModule["db"];
  nodeId: string;
  release(): void;
}

/**
 * Load core against THIS install's DB and take the node singleton lease.
 * Core's idempotent schema initializers run here (the same ones a node start
 * runs); nothing destructive happens before the backup.
 */
export async function loadCoreExclusive(
  dbPath: string,
  sameFile: (a: string, b: string) => boolean,
): Promise<CoreHandle> {
  const core = await import("@negotium/core");
  const { NODE_ID } = await import("@negotium/core/node-host");
  const db = core.db as unknown as SqlDb & CoreModule["db"];
  const mainFile = (
    db.query("PRAGMA database_list").all() as Array<{ name: string; file: string }>
  ).find((entry) => entry.name === "main")?.file;
  if (!mainFile || !sameFile(mainFile, dbPath)) {
    refuse(`core opened ${mainFile ?? "?"}, not ${dbPath}; run on the node host with its own env`);
  }
  let lost = false;
  const lease = core.acquireRuntimeProcessLease(NODE_DAEMON_ROLE, {
    onLost: () => {
      lost = true;
    },
  });
  if (!lease) {
    refuse(
      "could not take the node-daemon lease: a node is running (or just stopped; retry in 5s)",
    );
  }
  const others = (
    db
      .query("SELECT role, pid, heartbeat_at, owner_id FROM runtime_process_leases")
      .all() as Array<{
      role: string;
      pid: number;
      heartbeat_at: number;
      owner_id: string;
    }>
  ).filter(
    (row) =>
      row.owner_id !== lease.ownerId &&
      (Date.now() - Number(row.heartbeat_at) <= PROCESS_LEASE_STALE_MS ||
        pidAlive(Number(row.pid))),
  );
  if (others.length > 0) {
    lease.stop();
    refuse(
      `other Negotium processes hold this database: ${others.map((o) => `${o.role} (pid ${o.pid})`).join(", ")}`,
    );
  }
  return {
    core,
    db,
    nodeId: NODE_ID,
    release() {
      lease.stop();
      if (lost) throw new Error("the node-daemon lease was lost during the apply");
    },
  };
}

// ── verified backup ───────────────────────────────────────────────────────

export interface BackupResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * VACUUM INTO → fsync(file) → verify → rename → fsync(dir), in that order,
 * each through `seam`. SQLite refuses to VACUUM INTO an existing file (even an
 * empty one), so the target is a new name inside a fresh `mkdtemp` staging
 * directory (0700, ours) under the pinned backup dir; the file is then opened
 * `O_NOFOLLOW`, checked to be a single-link regular file, chmod 0600, and its
 * inode is re-checked before the no-clobber rename. `verify` gets the backup
 * opened `immutable=1` read-only with `safeIntegers` (int64 values exact).
 */
export function takeVerifiedBackup(
  db: SqlDb,
  dir: SafeDir,
  label: string,
  seam: FsSeam,
  verify: (backup: Database) => void,
): BackupResult {
  const finalName = randomBasename(`pre-${label}`, ".db");
  recheckSafeDir(dir);
  const staging = mkdtempSync(join(dir.path, ".staging-"));
  const tempPath = join(staging, "backup.db");
  seam.event?.("create", tempPath);
  let fd: number | null = null;
  try {
    openSafeDir(staging);
    db.query("VACUUM INTO ?").run(tempPath);
    seam.event?.("vacuum-into", tempPath);
    fd = openSync(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) refuse(`${tempPath} is not a fresh regular file`);
    fchmodSync(fd, 0o600);
    const file = { fd, path: tempPath, dev: stat.dev, ino: stat.ino };
    seam.fsyncFile(fd, tempPath);
    seam.event?.("fsync-file", tempPath);
    closeSync(fd);
    fd = null;

    const backup = new Database(`file:${tempPath}?immutable=1`, {
      readonly: true,
      safeIntegers: true,
    });
    try {
      const check = backup.query("PRAGMA quick_check").get() as { quick_check: string } | null;
      if (check?.quick_check !== "ok") {
        refuse(`backup quick_check failed: ${check?.quick_check ?? "?"}`);
      }
      verify(backup);
    } finally {
      backup.close();
    }
    const bytes = readFileSync(tempPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    seam.event?.("verify", tempPath);

    recheckSafeDir(dir);
    assertSameFile(file);
    const finalPath = join(dir.path, finalName);
    seam.renameNoClobber(tempPath, finalPath);
    seam.event?.("rename", finalPath);
    rmSync(staging, { recursive: true, force: true });
    seam.fsyncDir(dir.path);
    seam.event?.("fsync-dir", dir.path);
    return { path: finalPath, sha256, sizeBytes: bytes.length };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(staging, { recursive: true, force: true });
    if (error instanceof AdminError) throw error;
    throw new AdminError(
      ADMIN_EXIT.error,
      `backup failed (nothing changed): ${errorMessage(error)}`,
    );
  }
}

// ── journal + audit ───────────────────────────────────────────────────────

export const JOURNAL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS admin_operation_journal (
    run_id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    targets TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('prepared','committed','done','followup_failed','aborted')),
    backup_path TEXT NOT NULL,
    backup_sha256 TEXT NOT NULL,
    report_sha256 TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

export const AUDIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    command TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    detail TEXT,
    applied_at TEXT NOT NULL
  )`;

export function newRunId(command: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${command}-${stamp}-${randomBytes(6).toString("hex")}`;
}

type TxDb = SqlDb & { transaction<T>(fn: () => T): { immediate(): T } & (() => T) };

export function journalPrepared(
  db: TxDb,
  entry: {
    runId: string;
    command: string;
    targets: string[];
    backup: BackupResult;
    reportSha256: string;
    detail: unknown;
  },
): void {
  const now = new Date().toISOString();
  db.transaction(() => {
    db.exec(JOURNAL_TABLE_SQL);
    db.exec(AUDIT_TABLE_SQL);
    db.query(
      `INSERT INTO admin_operation_journal
         (run_id, command, targets, phase, backup_path, backup_sha256, report_sha256, detail, created_at, updated_at)
       VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.runId,
      entry.command,
      JSON.stringify(entry.targets),
      entry.backup.path,
      entry.backup.sha256,
      entry.reportSha256,
      JSON.stringify(entry.detail ?? null),
      now,
      now,
    );
  }).immediate();
}

/** Inside the destructive transaction: prepared → committed (must hit exactly one row). */
export function journalMarkCommitted(db: SqlDb, runId: string): void {
  const result = db
    .query(
      `UPDATE admin_operation_journal SET phase = 'committed', updated_at = ?
       WHERE run_id = ? AND phase = 'prepared'`,
    )
    .run(new Date().toISOString(), runId);
  if (Number(result?.changes ?? 0) !== 1) {
    throw new AdminError(ADMIN_EXIT.drift, `journal row ${runId} is not in phase prepared`);
  }
}

/** Best effort (after commit or after rollback); returns whether it was written. */
export function journalSetPhase(
  db: SqlDb,
  runId: string,
  phase: "done" | "followup_failed" | "aborted",
  detail?: string,
): boolean {
  try {
    db.query(
      `UPDATE admin_operation_journal
       SET phase = ?, updated_at = ?, detail = COALESCE(?, detail) WHERE run_id = ?`,
    ).run(phase, new Date().toISOString(), detail ?? null, runId);
    return true;
  } catch {
    return false;
  }
}

export interface AuditEntry {
  runId: string;
  command: string;
  entity: string;
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  detail?: unknown;
}

export function writeAudit(db: SqlDb, entries: readonly AuditEntry[]): void {
  const appliedAt = new Date().toISOString();
  for (const entry of entries) {
    db.query(
      `INSERT INTO admin_audit_log
         (run_id, command, entity, entity_id, field, old_value, new_value, detail, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.runId,
      entry.command,
      entry.entity,
      entry.entityId,
      entry.field,
      entry.oldValue,
      entry.newValue,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      appliedAt,
    );
  }
}
