/**
 * Storage-free limits shared by the session-history readers and the tool
 * schemas that describe them. Kept apart from `session-history-reader.ts` so
 * the session-comm factory can describe its `*_of` tools without importing
 * the conversation store.
 */
export const SESSION_HISTORY_DEFAULT_MAX_CALLS = 20;
export const SESSION_HISTORY_DEFAULT_MAX_TOTAL_BYTES = 768 * 1024;
export const SESSION_HISTORY_DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
export const SESSION_HISTORY_DEFAULT_LINE_LIMIT = 300;
export const SESSION_HISTORY_MAX_LINE_LIMIT = 500;
export const SESSION_HISTORY_DEFAULT_SEARCH_LIMIT = 20;
export const SESSION_HISTORY_MAX_SEARCH_LIMIT = 50;

export interface SessionHistoryBudget {
  maxCalls?: number;
  maxTotalBytes?: number;
  maxChunkBytes?: number;
}

/** Budget overrides from `NEGOTIUM_SESSION_HISTORY_*`; unset or invalid values fall back to defaults. */
export function sessionHistoryBudgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): SessionHistoryBudget {
  const positive = (name: string): number | undefined => {
    const raw = env[name];
    if (!raw) return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  return {
    maxCalls: positive("NEGOTIUM_SESSION_HISTORY_MAX_CALLS"),
    maxTotalBytes: positive("NEGOTIUM_SESSION_HISTORY_MAX_TOTAL_BYTES"),
    maxChunkBytes: positive("NEGOTIUM_SESSION_HISTORY_MAX_CHUNK_BYTES"),
  };
}
