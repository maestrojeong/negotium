import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonlEntry, readJsonlLines } from "#platform/jsonl";
import { logger } from "#platform/logger";
import { getTopicSessionId } from "#storage/api-topics";
import { resolveStorageLogDir } from "#storage/storage-host";
import type { AgentKind, TokenUsage } from "#types";

export interface QueryRecord {
  schemaVersion: 2;
  timestamp: string; // ISO 8601 UTC
  session: string; // topic title (legacy output name)
  topicId: string;
  providerSessionId?: string;
  agent: AgentKind;
  model: string;
  /** Cache-miss input only. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextTokens?: number;
  contextWindow?: number;
  estimatedCostUsd: number;
}

export interface Bucket {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  queries: number;
  estimatedCostUsd: number;
}

export interface CurrentSessionUsage {
  timestamp: string;
  topicId: string;
  topicTitle: string;
  providerSessionId?: string;
  agent: AgentKind;
  model: string;
  contextTokens: number;
  contextWindow: number;
}

export interface TopicUsageSummary extends Bucket {
  topicId: string;
  currentSession?: CurrentSessionUsage;
}

function emptyBucket(): Bucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    queries: 0,
    estimatedCostUsd: 0,
  };
}

export function tokenStatsFileId(userId: number | string): string {
  const rawUserId = String(userId);
  // Preserve existing filenames for ordinary IDs, but never let an external
  // identity introduce path separators or unbounded filename length.
  return /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,255}$/.test(rawUserId) && !rawUserId.includes("..")
    ? rawUserId
    : `sha256-${createHash("sha256").update(rawUserId).digest("hex")}`;
}

function queriesPath(userId: number | string): string {
  const fileId = tokenStatsFileId(userId);
  const logDir = resolveStorageLogDir();
  mkdirSync(logDir, { recursive: true });
  return join(logDir, `token-queries-${fileId}.jsonl`);
}

function loadRecords(userId: number | string): unknown[] {
  try {
    return readJsonlLines(queriesPath(userId)).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
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
    | "inputTokens"
    | "outputTokens"
    | "cacheCreationInputTokens"
    | "cacheReadInputTokens"
    | "estimatedCostUsd"
  >,
): number {
  return b.estimatedCostUsd;
}

type TokenPrices = {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead: number;
};

const TOKEN_PRICES: Record<string, TokenPrices> = {
  "codex:gpt-6-astra": { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  "codex:gpt-5.6-sol": { input: 5, cacheRead: 0.5, output: 30 },
  "codex:gpt-5.6-terra": { input: 2.5, cacheRead: 0.25, output: 15 },
  "codex:gpt-5.6-luna": { input: 1, cacheRead: 0.1, output: 6 },
  // Fable 5.1 (2026-09-01) cut cache-read pricing 75% from $1/M to $0.25/M.
  "claude:fable": { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  "claude:opus": { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude:sonnet": { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  "maestro:kimi-k3": { input: 3, cacheRead: 0.3, output: 15 },
  "maestro:kimi-k2.7-code": { input: 0.95, cacheRead: 0.19, output: 4 },
  // Approximate published GLM rates; no separate cache-read rate is published,
  // so cache reads conservatively use the ordinary input price.
  "maestro:glm-5.3": { input: 1.4, cacheRead: 1.4, output: 4.4 },
  "maestro:glm-5.2": { input: 0.95, cacheRead: 0.95, output: 3 },
  "maestro:glm-5.3-flash": { input: 0.15, cacheRead: 0.15, output: 0.5 },
  "maestro:deepseek-pro": { input: 0.435, cacheRead: 0.003625, output: 0.87 },
  "maestro:deepseek-flash": { input: 0.14, cacheRead: 0.0028, output: 0.28 },
};

function estimateUsageCost(
  agent: AgentKind,
  model: string,
  usage: Pick<
    QueryRecord,
    "inputTokens" | "outputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens"
  >,
): number {
  const prices = TOKEN_PRICES[`${agent}:${model}`];
  if (!prices) return 0;
  return (
    (usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      (agent === "claude"
        ? usage.cacheCreationInputTokens * (prices.cacheWrite ?? prices.input)
        : 0) +
      usage.cacheReadInputTokens * prices.cacheRead) /
    1_000_000
  );
}

function isQueryRecord(value: unknown): value is QueryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<QueryRecord>;
  return (
    record.schemaVersion === 2 &&
    typeof record.timestamp === "string" &&
    typeof record.session === "string" &&
    typeof record.topicId === "string" &&
    typeof record.agent === "string" &&
    typeof record.model === "string" &&
    typeof record.inputTokens === "number" &&
    typeof record.outputTokens === "number" &&
    typeof record.cacheCreationInputTokens === "number" &&
    typeof record.cacheReadInputTokens === "number" &&
    typeof record.estimatedCostUsd === "number"
  );
}

/** 쿼리 완료 시 호출 — JSONL에 한 줄 추가 */
export function recordUsage(
  userId: number | string,
  session: string,
  usage: TokenUsage,
  context: {
    topicId: string;
    providerSessionId?: string;
    agent: AgentKind;
    model: string;
  },
) {
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;
  // Claude reports cache buckets separately; Codex and Maestro include cache
  // hits in their provider input total.
  const inputTokens =
    context.agent === "claude"
      ? usage.inputTokens
      : Math.max(0, usage.inputTokens - cacheReadInputTokens);
  const normalized = {
    inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens,
  };
  const record: QueryRecord = {
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    session,
    topicId: context.topicId,
    ...(context.providerSessionId ? { providerSessionId: context.providerSessionId } : {}),
    agent: context.agent,
    model: context.model,
    ...normalized,
    ...(usage.contextTokens !== undefined ? { contextTokens: usage.contextTokens } : {}),
    ...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
    estimatedCostUsd: usage.costUsd ?? estimateUsageCost(context.agent, context.model, normalized),
  };
  try {
    appendJsonlEntry(queriesPath(userId), record);
  } catch (e) {
    logger.warn({ err: e, userId }, "token-stats: Failed to record");
  }
}

export function deleteTopicStats(userId: number | string, topicId: string): void {
  const path = queriesPath(userId);
  try {
    const kept = readJsonlLines(path).filter((line) => {
      try {
        const record = JSON.parse(line) as { topicId?: unknown };
        return record.topicId !== topicId;
      } catch {
        return true;
      }
    });
    writeFileSync(path, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.warn({ err: e, userId, topicId }, "token-stats: Failed to delete topic stats");
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
  currentSessions: CurrentSessionUsage[];
  ignoredLegacyRecords: number;
  estimatedCostUsd: number;
} {
  const records = loadRecords(userId);

  const fromTs = from ? new Date(from).getTime() : 0;
  const toTs = to ? new Date(to).getTime() : Infinity;

  if ((from && Number.isNaN(fromTs)) || (to && Number.isNaN(toTs))) {
    logger.warn({ from, to }, "token-stats: Invalid date range, returning empty");
    return {
      total: emptyBucket(),
      byHour: {},
      bySession: {},
      currentSessions: [],
      ignoredLegacyRecords: 0,
      estimatedCostUsd: 0,
    };
  }

  const total = emptyBucket();
  const byHour: Record<string, Bucket> = {};
  const bySession: Record<string, Bucket> = {};
  const currentSessions = new Map<string, CurrentSessionUsage>();
  let ignoredLegacyRecords = 0;

  for (const raw of records) {
    if (!isQueryRecord(raw)) {
      ignoredLegacyRecords += 1;
      continue;
    }
    const r = raw;
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
      bucket.estimatedCostUsd += r.estimatedCostUsd;
    }

    if (r.contextTokens !== undefined && r.contextWindow !== undefined && r.contextWindow > 0) {
      currentSessions.set(r.topicId, {
        timestamp: r.timestamp,
        topicId: r.topicId,
        topicTitle: r.session,
        ...(r.providerSessionId ? { providerSessionId: r.providerSessionId } : {}),
        agent: r.agent,
        model: r.model,
        contextTokens: r.contextTokens,
        contextWindow: r.contextWindow,
      });
    }
  }

  return {
    total,
    byHour,
    bySession,
    currentSessions: [...currentSessions.values()].sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    ),
    ignoredLegacyRecords,
    estimatedCostUsd: calcCost(total),
  };
}

/** Exact all-time usage for one topic, independent of transcript pagination. */
export function getTopicStats(
  userId: number | string,
  topicId: string,
  activeProviderSessionId = getTopicSessionId(topicId) ?? undefined,
): TopicUsageSummary {
  const total = emptyBucket();
  let currentSession: CurrentSessionUsage | undefined;

  for (const raw of loadRecords(userId)) {
    if (!isQueryRecord(raw) || raw.topicId !== topicId) continue;

    total.inputTokens += raw.inputTokens;
    total.outputTokens += raw.outputTokens;
    total.cacheCreationInputTokens += raw.cacheCreationInputTokens;
    total.cacheReadInputTokens += raw.cacheReadInputTokens;
    total.queries += 1;
    total.estimatedCostUsd += raw.estimatedCostUsd;

    if (
      raw.contextTokens !== undefined &&
      raw.contextWindow !== undefined &&
      raw.contextWindow > 0 &&
      activeProviderSessionId !== undefined &&
      raw.providerSessionId === activeProviderSessionId &&
      (!currentSession || raw.timestamp > currentSession.timestamp)
    ) {
      currentSession = {
        timestamp: raw.timestamp,
        topicId: raw.topicId,
        topicTitle: raw.session,
        ...(raw.providerSessionId ? { providerSessionId: raw.providerSessionId } : {}),
        agent: raw.agent,
        model: raw.model,
        contextTokens: raw.contextTokens,
        contextWindow: raw.contextWindow,
      };
    }
  }

  return { topicId, ...total, ...(currentSession ? { currentSession } : {}) };
}
