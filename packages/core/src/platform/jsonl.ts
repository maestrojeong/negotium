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
// after `LOCK_STALE_MS`. As a last resort, after `LOCK_TIMEOUT_MS` of
// retries, the lock is bypassed — the entry survives but may interleave;
// preferable to dropping it entirely.
const LOCK_SUFFIX = ".lock";
const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 1500;
const LOCK_STALE_MS = 5000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
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
    while (!acquired && Date.now() - start < LOCK_TIMEOUT_MS) {
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

  if (!acquired) {
    // Best-effort fallback: append unlocked. Worst case the line interleaves
    // with another writer and one of them is dropped at parse time — still
    // better than dropping the entry on the floor here.
    appendFileSync(filePath, payload);
    return;
  }

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
