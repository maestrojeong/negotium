/**
 * Size-based rotation for daemon stderr logs.
 *
 * Negotium adapters (`negotium-terminal`, `negotium-telegram`, `negotium-otium`)
 * each spawn the node daemon with its stderr redirected straight to
 * `<LOG_DIR>/node-daemon.log`. That file is opened once at spawn time and
 * accumulates for the daemon's whole lifetime with no cap, so long-running
 * hosts eventually carry an unbounded log file.
 *
 * True in-place rotation (SIGHUP-style reopen) would require the daemon to
 * cooperate by reopening its own stderr fd, which Bun does not expose. The
 * practical fix instead rotates *before* spawn: every time a CLI is about to
 * start the daemon, check the previous log's size and, if it crossed the
 * threshold, rename it aside with a timestamp so the new spawn starts a
 * fresh, empty file.
 */

import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** Rotate once the log exceeds this size (bytes) at the next daemon start. */
export const DEFAULT_DAEMON_LOG_ROTATE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * If `logPath` exists and is at least `maxBytes`, rename it aside with an
 * ISO-ish timestamp suffix so a fresh file can be created at `logPath`.
 * No-op (and never throws) when the file is missing, under the threshold, or
 * the rename fails for any reason — log rotation must never block startup.
 */
export function rotateOversizedLog(
  logPath: string,
  maxBytes: number = DEFAULT_DAEMON_LOG_ROTATE_BYTES,
): void {
  try {
    if (!existsSync(logPath)) return;
    const { size } = statSync(logPath);
    if (size < maxBytes) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(logPath, "..");
    const base = logPath.slice(dir.length + 1);
    renameSync(logPath, join(dir, `${base}.${stamp}`));
  } catch {
    // Best-effort: a failed rotation should never prevent the daemon from starting.
  }
}
