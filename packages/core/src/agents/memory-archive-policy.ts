export interface MemoryArchiveMessage {
  author_id: string;
  agent_type?: string | null;
  kind?: string | null;
}

/**
 * Shared lifecycle gate for reset/delete memory distillation. Keep the raw
 * forensic archive even below this threshold, but do not spend an agent turn
 * on a session with five or fewer completed user/assistant exchanges. This
 * mirrors Clawgram's lifecycle-level MIN_EXCHANGE_COUNT policy.
 */
export const MIN_MEMORY_ARCHIVE_EXCHANGES = 6;

export interface MemoryArchiveTopicContext {
  isSubagent?: boolean;
  memoryTopicId?: string;
}

/**
 * Explicit-memory subagents are usually short, focused turns. Persist one
 * completed exchange back to their selected memory topic, while retaining the
 * normal threshold for regular topics and incomplete/failed turns.
 */
export function meetsMemoryArchiveExchangeThreshold(
  exchangeCount: number,
  minExchanges: number,
  topic: MemoryArchiveTopicContext,
): boolean {
  if (exchangeCount <= 0) return false;
  if (topic.isSubagent && topic.memoryTopicId) return true;
  return exchangeCount >= minExchanges;
}

/** Count completed conversational exchanges while ignoring system/tool/card noise. */
export function countMemoryArchiveExchanges(rows: readonly MemoryArchiveMessage[]): number {
  let waitingForAssistant = false;
  let completed = 0;

  for (const row of rows) {
    const assistant = row.author_id === "ai" || Boolean(row.agent_type);
    const conversational = row.kind == null || row.kind === "message";
    if (!assistant && row.author_id !== "system" && conversational) {
      waitingForAssistant = true;
      continue;
    }
    if (assistant && conversational && waitingForAssistant) {
      completed++;
      waitingForAssistant = false;
    }
  }

  return completed;
}
