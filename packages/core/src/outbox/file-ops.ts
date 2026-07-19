import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { readJsonlLines } from "#platform/jsonl";
import { logger } from "#platform/logger";

const PROCESSING_SUFFIX = ".processing";

export interface OutboxLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface OutboxFileHost {
  logger: OutboxLogger;
  readJsonlLines(path: string): string[];
}

export interface OutboxFileOps {
  isProcessingFile(name: string): boolean;
  drainOutboxFile(
    filePath: string,
    label: string,
  ): { lines: string[]; processingPath: string } | null;
  deleteProcessingFile(processingPath: string, label: string, consumedLines?: number): void;
  parseOutboxLine<T>(line: string, label: string): T | null;
  processOutboxFile<T extends Record<string, unknown>>(
    filePath: string,
    label: string,
    handler: (entry: T) => Promise<void>,
    opts?: { maxRetries?: number },
  ): Promise<void>;
}

const defaultHost: OutboxFileHost = { logger, readJsonlLines };
const hostContext = new AsyncLocalStorage<OutboxFileHost>();

function host(): OutboxFileHost {
  return hostContext.getStore() ?? defaultHost;
}

/** True if `name` is an in-flight `.processing` claim file written by drainOutboxFile. */
export function isProcessingFile(name: string): boolean {
  return name.endsWith(PROCESSING_SUFFIX);
}

function tryUnlink(path: string, label: string, reason: string) {
  try {
    unlinkSync(path);
  } catch (e) {
    // ENOENT means another path already cleaned this up (e.g. concurrent
    // drain, double-delete in a retry loop). Not worth warning about.
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      host().logger.debug({ path }, `${label}: ${reason} (already gone)`);
      return;
    }
    host().logger.warn({ err: e, path }, `${label}: ${reason}`);
  }
}

/**
 * Atomically claim a .jsonl outbox file for processing.
 * Recovers leftover .processing files from crashes, renames the pending file
 * to .processing to prevent race conditions, and returns the parsed lines.
 * Returns null if the file doesn't exist or can't be claimed.
 *
 * Partial-failure edge case: when a crash leftover is merged back into pending,
 * `readFileSync` → `appendFileSync` → `unlinkSync` runs sequentially. If
 * `appendFileSync` throws mid-write (e.g. ENOSPC), the pending file receives a
 * partial copy of the leftover and the catch branch still unlinks the leftover
 * to avoid an infinite retry loop — so the tail of the leftover can be lost.
 * In practice the next drain parses the partial line as invalid JSON and drops
 * it via `parseOutboxLine`. This is a deliberate trade-off: we accept the rare
 * partial loss instead of stalling the outbox when the disk is full.
 */
export function drainOutboxFile(
  filePath: string,
  label: string,
): { lines: string[]; processingPath: string } | null {
  const processingPath = filePath + PROCESSING_SUFFIX;
  const hasPending = existsSync(filePath);
  const hasLeftover = existsSync(processingPath);

  // Merge leftover into pending before claim.
  // hasPending=false: normal crash recovery — leftover is all we have.
  // hasPending=true:  crash + writer race — without merge, the rename below
  //                   would overwrite leftover and drop its lines.
  if (hasLeftover) {
    // warn on crash+race (rare), info on plain recovery (expected after crash)
    const logMsg = `${label}: merging leftover .processing before claim`;
    const logCtx = { filePath, processingPath, hadPending: hasPending };
    if (hasPending) host().logger.warn(logCtx, logMsg);
    else host().logger.info(logCtx, logMsg);
    try {
      const leftover = readFileSync(processingPath, "utf-8");
      if (leftover) appendFileSync(filePath, leftover.endsWith("\n") ? leftover : `${leftover}\n`);
      unlinkSync(processingPath);
    } catch (e) {
      host().logger.error(
        { err: e, processingPath },
        `${label}: failed to merge leftover — data may be lost`,
      );
      tryUnlink(processingPath, label, "failed to clean up leftover after merge error");
    }
  }

  if (!existsSync(filePath)) return null;

  // Atomically rename to prevent race condition with writer
  try {
    renameSync(filePath, processingPath);
  } catch (e) {
    host().logger.warn({ err: e, filePath }, `${label}: failed to rename for processing`);
    return null;
  }

  // Read lines
  try {
    const lines = host().readJsonlLines(processingPath);
    return { lines, processingPath };
  } catch (e) {
    host().logger.warn({ err: e, processingPath }, `${label}: failed to read processing file`);
    tryUnlink(processingPath, label, "failed to delete corrupt processing file");
    return null;
  }
}

/**
 * Delete the .processing file after all entries are consumed.
 *
 * Writer-race salvage: `appendFileSync` racing `drainOutboxFile`'s rename can
 * land a line on the claimed inode AFTER the drainer already read it. Without
 * a recheck, unlinking here would silently destroy that entry. When
 * `consumedLines` is provided, any lines beyond it are appended back to the
 * original pending file before the claim is deleted (at-least-once preserved).
 */
export function deleteProcessingFile(
  processingPath: string,
  label: string,
  consumedLines?: number,
) {
  if (consumedLines !== undefined && processingPath.endsWith(PROCESSING_SUFFIX)) {
    try {
      const current = host().readJsonlLines(processingPath);
      if (current.length > consumedLines) {
        const pendingPath = processingPath.slice(0, -PROCESSING_SUFFIX.length);
        const tail = current.slice(consumedLines).join("\n");
        appendFileSync(pendingPath, `${tail}\n`);
        host().logger.warn(
          { processingPath, salvaged: current.length - consumedLines },
          `${label}: writer raced the drain — salvaged late lines back to pending`,
        );
      }
    } catch (e) {
      host().logger.warn({ err: e, processingPath }, `${label}: writer-race recheck failed`);
    }
  }
  tryUnlink(processingPath, label, "failed to delete processing file");
}

/**
 * Parse a single JSONL line. Returns null (and logs an error) on invalid JSON.
 * Keeps the parse + error-log pattern in one place instead of repeating it in
 * every flush function.
 */
export function parseOutboxLine<T>(line: string, label: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    host().logger.error({ label, line: line.slice(0, 120) }, `${label}: Invalid JSON, dropping`);
    return null;
  }
}

/**
 * Drain an outbox file and invoke `handler` for each parsed entry.
 * Handles drain → parse → process → delete-processing → write-back-failures in one call.
 *
 * `handler` should throw to signal a retryable failure.
 * Failed entries are written back to `filePath` for the next flush cycle.
 * Pass `maxRetries` to drop entries that have exceeded the retry budget.
 *
 * Delivery: at-least-once. The `.processing` claim is deleted only AFTER all
 * entries were handled — a crash mid-processing leaves the claim on disk and
 * the next drain's leftover-merge redelivers the whole batch (including
 * already-handled entries). Handlers must therefore be idempotent or accept
 * duplicates; deleting the claim up-front would instead silently lose every
 * unprocessed entry on crash, which is worse for every queue using this path.
 */
export async function processOutboxFile<T extends Record<string, unknown>>(
  filePath: string,
  label: string,
  handler: (entry: T) => Promise<void>,
  opts: { maxRetries?: number } = {},
): Promise<void> {
  const drained = drainOutboxFile(filePath, label);
  if (!drained) return;
  const { lines, processingPath } = drained;

  if (lines.length === 0) {
    deleteProcessingFile(processingPath, label, 0);
    return;
  }

  const MAX_RETRIES = opts.maxRetries ?? 0;
  const failedLines: string[] = [];

  for (const line of lines) {
    const entry = parseOutboxLine<T>(line, label);
    if (!entry) continue;

    const retryCount = (entry.retryCount as number | undefined) ?? 0;
    try {
      await handler(entry);
    } catch (err) {
      if (MAX_RETRIES > 0) {
        const next = retryCount + 1;
        if (next >= MAX_RETRIES) {
          host().logger.error(
            { err, label, retryCount: next },
            `${label}: Max retries reached, dropping`,
          );
        } else {
          host().logger.warn({ err, label, retryCount: next }, `${label}: Failed, will retry`);
          failedLines.push(JSON.stringify({ ...entry, retryCount: next }));
        }
      } else {
        host().logger.error({ err, label }, `${label}: Failed to process entry`);
      }
    }
  }

  // Drop the claim before writing failures back (same order as dm-queue):
  // a crash between the two redelivers nothing extra, while the reverse
  // order could double the failed entries (write-back + leftover merge).
  deleteProcessingFile(processingPath, label, lines.length);

  if (failedLines.length > 0) {
    try {
      appendFileSync(filePath, `${failedLines.join("\n")}\n`);
    } catch (e) {
      host().logger.error(
        { err: e, label, count: failedLines.length },
        `${label}: Failed to write back entries`,
      );
    }
  }
}

/** Bind outbox processing to caller-owned logging and JSONL parsing dependencies. */
export function createOutboxFileOps(boundHost: OutboxFileHost): OutboxFileOps {
  return {
    isProcessingFile,
    drainOutboxFile: (filePath, label) =>
      hostContext.run(boundHost, () => drainOutboxFile(filePath, label)),
    deleteProcessingFile: (processingPath, label, consumedLines) =>
      hostContext.run(boundHost, () => deleteProcessingFile(processingPath, label, consumedLines)),
    parseOutboxLine: <T>(line: string, label: string) =>
      hostContext.run(boundHost, () => parseOutboxLine<T>(line, label)),
    processOutboxFile: <T extends Record<string, unknown>>(
      filePath: string,
      label: string,
      handler: (entry: T) => Promise<void>,
      opts: { maxRetries?: number } = {},
    ) => hostContext.run(boundHost, () => processOutboxFile(filePath, label, handler, opts)),
  };
}
