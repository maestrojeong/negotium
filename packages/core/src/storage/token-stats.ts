import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendJsonlEntry, readJsonlLines } from "#platform/jsonl";
import { logger } from "#platform/logger";
import { resolveStorageLogDir } from "#storage/storage-host";

export interface QueryRecord {
  timestamp: string; // ISO 8601 UTC
  session: string; // topic name
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  queries: number;
}

function emptyBucket(): Bucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    queries: 0,
  };
}

export function tokenStatsFileId(userId: number | string): string {
  const rawUserId = String(userId);
  // Preserve existing filenames for ordinary IDs, but never let an external
  // identity introduce path separators or unbounded filename length.
  return /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,255}$/.test(rawUserId)
    ? rawUserId
    : `sha256-${createHash("sha256").update(rawUserId).digest("hex")}`;
}

function queriesPath(userId: number | string): string {
  const fileId = tokenStatsFileId(userId);
  const logDir = resolveStorageLogDir();
  mkdirSync(logDir, { recursive: true });
  return join(logDir, `token-queries-${fileId}.jsonl`);
}

function loadRecords(userId: number | string): QueryRecord[] {
  try {
    return readJsonlLines(queriesPath(userId)).flatMap((line) => {
      try {
        return [JSON.parse(line) as QueryRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function calcCost(
  b: Pick<
    Bucket,
    "inputTokens" | "outputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens"
  >,
): number {
  return (
    (b.inputTokens / 1_000_000) * 3.0 +
    (b.outputTokens / 1_000_000) * 15.0 +
    (b.cacheCreationInputTokens / 1_000_000) * 3.75 +
    (b.cacheReadInputTokens / 1_000_000) * 0.3
  );
}

/** 쿼리 완료 시 호출 — JSONL에 한 줄 추가 */
export function recordUsage(
  userId: number | string,
  session: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  },
) {
  const record: QueryRecord = {
    timestamp: new Date().toISOString(),
    session,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
  };
  try {
    appendJsonlEntry(queriesPath(userId), record);
  } catch (e) {
    logger.warn({ err: e, userId }, "token-stats: Failed to record");
  }
}

export function getStats(
  userId: number | string,
  from?: string,
  to?: string,
): {
  total: Bucket;
  byHour: Record<string, Bucket>;
  bySession: Record<string, Bucket>;
  estimatedCostUsd: number;
} {
  const records = loadRecords(userId);

  const fromTs = from ? new Date(from).getTime() : 0;
  const toTs = to ? new Date(to).getTime() : Infinity;

  if ((from && Number.isNaN(fromTs)) || (to && Number.isNaN(toTs))) {
    logger.warn({ from, to }, "token-stats: Invalid date range, returning empty");
    return { total: emptyBucket(), byHour: {}, bySession: {}, estimatedCostUsd: 0 };
  }

  const total = emptyBucket();
  const byHour: Record<string, Bucket> = {};
  const bySession: Record<string, Bucket> = {};

  for (const r of records) {
    const ts = new Date(r.timestamp).getTime();
    if (ts < fromTs || ts > toTs) continue;

    const hourKey = r.timestamp.slice(0, 13); // "2026-03-28T14"

    if (!byHour[hourKey]) byHour[hourKey] = emptyBucket();
    if (!bySession[r.session]) bySession[r.session] = emptyBucket();

    for (const bucket of [total, byHour[hourKey], bySession[r.session]]) {
      bucket.inputTokens += r.inputTokens;
      bucket.outputTokens += r.outputTokens;
      bucket.cacheCreationInputTokens += r.cacheCreationInputTokens;
      bucket.cacheReadInputTokens += r.cacheReadInputTokens;
      bucket.queries += 1;
    }
  }

  return { total, byHour, bySession, estimatedCostUsd: calcCost(total) };
}
