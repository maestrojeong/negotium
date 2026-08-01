import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { safeUnlink } from "#platform/file-utils";

export function readJsonlLines(filePath: string): string[] {
  return readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
}

/**
 * Parse a JSONL string (one JSON value per line) into an array of `T`.
 * Throws on malformed lines — use when a corrupt fixture/log should fail
 * loudly rather than silently drop entries (paired with `readJsonlLines`'
 * resilient counterpart for live data streams).
 */
export function parseJsonlText<T = unknown>(raw: string): T[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Read and JSON-parse a file. Returns null if the file is missing or contains
 * invalid JSON. Use when a missing/corrupt file should fall through to a
 * default rather than throw.
 */
export function readJsonFile<T = unknown>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Atomically replace a JSON file and fsync the new contents before rename. */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);
    fsyncDirectoryBestEffort(dir);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    safeUnlink(tmpPath);
    throw err;
  }
}

// --- Cross-process append lock ---
// POSIX `O_APPEND` is only atomic when the write payload fits in PIPE_BUF
// (Linux 4096, macOS 512). MCP servers and the bot run as separate
// processes that all `appendFileSync` to shared inbox/outbox files; a long
// `tell_session` prompt or large `ask_session` reply is comfortably above
// PIPE_BUF, and a concurrent append from another process can interleave at
// the byte level — the result fails JSON parse and the entire entry is
// silently dropped by `parseOutboxLine`.
//
// Mitigation: a sidecar `<filePath>.lock` created with `O_EXCL` serializes
// every append at the OS level. Lock is held for the duration of one
// `appendFileSync`, so the contention window is microseconds. Stale locks
// (process crashed mid-write) are detected via mtime and forcibly removed
// after `LOCK_STALE_MS`.
//
// When the lock still cannot be acquired within `LOCK_TIMEOUT_MS`, the append
// FAILS. It used to fall through to an unlocked `appendFileSync` on the theory
// that a possibly-interleaved entry beats a dropped one — but an interleaved
// write is exactly the corruption the lock exists to prevent, it can damage a
// neighbouring well-formed entry as well as its own, and `parseOutboxLine`
// discards the wreckage later and far from the cause. The caller was told the
// write succeeded. Failing loudly lets each caller choose: surface the error to
// its client, or log and continue.
//
// The timeout MUST outlast the staleness threshold. A writer killed while
// holding the lock leaves the file behind, and only the mtime check reclaims
// it. With a timeout shorter than `LOCK_STALE_MS` every append issued in the
// first few seconds after such a crash gave up *before* the reclaim could fire
// — measured as a ~3.5s window in which every append to that file failed, all
// of which the pre-throw fallback used to deliver. Waiting past the staleness
// threshold means a dead holder is always reclaimed rather than waited out, so
// a timeout now means a *live* holder has been stuck for over five seconds,
// which is a genuine fault worth reporting.
const LOCK_SUFFIX = ".lock";
const LOCK_RETRY_MS = 5;
const DEFAULT_LOCK_STALE_MS = 5000;
/** Headroom so a waiter never gives up exactly as the reclaim becomes due. */
const LOCK_TIMEOUT_HEADROOM_MS = 1500;

/**
 * Staleness threshold, overridable so tests can exercise the timeout path
 * without blocking a real five seconds.
 *
 * Read per call rather than captured at import: the constants are consulted
 * once per append, which is nothing next to the file I/O that follows, and a
 * module-level snapshot could not be adjusted by a test that imports this
 * module transitively.
 */
function lockStaleMs(): number {
  const raw = Number.parseInt(process.env.NEGOTIUM_JSONL_LOCK_STALE_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCK_STALE_MS;
}

/** Always > `lockStaleMs()`, so a dead holder is reclaimed rather than waited out. */
function lockTimeoutMs(): number {
  return lockStaleMs() + LOCK_TIMEOUT_HEADROOM_MS;
}
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/**
 * The append lock could not be acquired, so nothing was written.
 *
 * Distinguishable from an I/O error so callers can retry, degrade, or report
 * contention specifically. Nothing was appended when this is thrown.
 */
export class JsonlLockTimeoutError extends Error {
  constructor(
    readonly filePath: string,
    readonly timeoutMs: number,
  ) {
    super(`jsonl append lock busy after ${timeoutMs}ms; nothing written to ${filePath}`);
    this.name = "JsonlLockTimeoutError";
  }
}

/** Synchronous, non-spinning sleep supported by both Bun and Node MCP workers. */
function sleepForAppendLock(ms: number): void {
  Atomics.wait(LOCK_SLEEP, 0, 0, ms);
}

function tryAcquireAppendLock(lockPath: string): boolean {
  try {
    closeSync(openSync(lockPath, "wx")); // O_CREAT | O_EXCL — atomic
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

function isStaleLock(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > lockStaleMs();
  } catch {
    return false;
  }
}

/**
 * Append a JSON-encoded entry + newline to a JSONL file. Ensures the parent
 * directory exists and serializes concurrent multi-process appends through a
 * sidecar lock so payloads larger than PIPE_BUF do not interleave.
 *
 * The drainer side (`outbox/file-ops.ts`) claims the file via atomic rename
 * and handles recovery of leftover `.processing` files from crashes.
 */
export function appendJsonlEntry(filePath: string, entry: unknown): void {
  appendJsonlLine(filePath, `${JSON.stringify(entry)}\n`);
}

/**
 * Append an already-serialized JSONL line (must end with "\n") under the
 * same cross-process append lock as `appendJsonlEntry`. Use when you
 * want to write back a raw line **exactly** — e.g. flusher tail-writeback
 * preserving lines that current parser can't decode, so a future parser
 * release still sees them.
 */
export function appendJsonlLine(filePath: string, line: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}${LOCK_SUFFIX}`;
  const payload = line.endsWith("\n") ? line : `${line}\n`;

  let acquired = tryAcquireAppendLock(lockPath);
  // Pre-check: if the existing lock is already stale (writer crashed before
  // unlinking), reclaim it before sleeping. Saves the entire retry budget
  // for the common stale-leftover case.
  if (!acquired && isStaleLock(lockPath)) {
    safeUnlink(lockPath);
    acquired = tryAcquireAppendLock(lockPath);
  }
  if (!acquired) {
    const start = Date.now();
    const timeoutMs = lockTimeoutMs();
    while (!acquired && Date.now() - start < timeoutMs) {
      // Codex launches built-in stdio MCPs under Node+tsx while the runtime
      // itself uses Bun. Atomics.wait gives both processes a blocking sleep
      // without a CPU-spinning fallback or a Bun-only global.
      sleepForAppendLock(LOCK_RETRY_MS);
      acquired = tryAcquireAppendLock(lockPath);
      // Recheck staleness inside the loop so a writer that crashes mid-wait
      // doesn't leave us spinning the whole timeout.
      if (!acquired && isStaleLock(lockPath)) {
        safeUnlink(lockPath);
        acquired = tryAcquireAppendLock(lockPath);
      }
    }
  }

  if (!acquired) throw new JsonlLockTimeoutError(filePath, lockTimeoutMs());

  try {
    appendFileSync(filePath, payload);
  } finally {
    safeUnlink(lockPath);
  }
}

/** Overwrite a JSONL file with the given entries. Trailing newline included. */
export function writeJsonlFile(filePath: string, entries: readonly unknown[]): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const payload = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w");
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);
    fsyncDirectoryBestEffort(dir);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function fsyncDirectoryBestEffort(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not portable across every runtime/filesystem. The
    // file fsync + rename above is the important integrity boundary; this is
    // best-effort durability for the directory entry.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
