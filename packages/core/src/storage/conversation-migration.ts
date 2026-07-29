import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "#platform/logger";
import { sanitizeTopicName } from "#security/sanitize";
import { type ApiMessageRow, getAllMessagesForTopic } from "#storage/api-messages";
import { listTopics } from "#storage/api-topics";
import {
  type ConversationEntry,
  getActiveConversationPath,
  getConversationPath,
  replaceConversationStrict,
  replaceRawConversationStrict,
} from "#storage/conversations";
import { resolveStorageDataDir } from "#storage/storage-host";
import { type AgentKind, isAgentKind } from "#types";

const COMPACT_CONTEXT_MARKER = "[Negotium compacted context]";
const MIGRATION_NAME = "raw-active-v1";

export interface ConversationMigrationResult {
  migrated: number;
  skipped: number;
  restoredEntries: number;
}

function readEntries(path: string): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ConversationEntry);
    } catch (error) {
      logger.warn(
        { err: error, path, line: index + 1 },
        "conversation migration: malformed JSONL line skipped",
      );
    }
  }
  return entries;
}

function compactionEntryIndex(entries: ConversationEntry[]): number {
  return entries.findIndex((entry, index) => {
    const response = entries[index + 1]?.event;
    return (
      entry.event.type === "user_message" &&
      entry.event.content.startsWith(COMPACT_CONTEXT_MARKER) &&
      response?.type === "result" &&
      response.content.trim().length > 0
    );
  });
}

function rowAgent(row: ApiMessageRow, fallback: AgentKind): AgentKind {
  return isAgentKind(row.agent_type) ? row.agent_type : fallback;
}

/**
 * SQLite stores incremental UI updates, so one query can have many assistant
 * rows. Keep only the final ordinary row per query while preserving explicit
 * ask/subagent messages and all user messages.
 */
export function restoreVisibleConversationEntries(
  rows: ApiMessageRow[],
  compactedAt: string,
  fallbackAgent: AgentKind,
): ConversationEntry[] {
  const eligible = rows.filter(
    (row) => row.deleted === 0 && row.created_at < compactedAt && row.text.trim(),
  );
  const finalAssistantRowByQuery = new Map<string, number>();
  for (const row of eligible) {
    if (row.author_id === "ai" && row.query_id && !row.kind) {
      finalAssistantRowByQuery.set(row.query_id, row.rowid ?? 0);
    }
  }

  const entries: ConversationEntry[] = [];
  for (const row of eligible) {
    if (row.author_id === "system" || row.kind === "system") continue;
    if (row.author_id === "ai") {
      if (
        row.query_id &&
        !row.kind &&
        finalAssistantRowByQuery.get(row.query_id) !== (row.rowid ?? 0)
      ) {
        continue;
      }
      entries.push({
        ts: row.created_at,
        agent: rowAgent(row, fallbackAgent),
        event: { type: "result", content: row.text, stopReason: "migrated_visible_message" },
      });
      continue;
    }
    entries.push({
      ts: row.created_at,
      agent: fallbackAgent,
      event: { type: "user_message", content: row.text },
    });
  }
  return entries;
}

/**
 * Upgrade legacy logs that were destructively replaced by compaction.
 *
 * The legacy file is retained as the active provider projection. Raw history
 * is rebuilt best-effort from durable visible messages before the compaction
 * boundary, followed by the legacy compacted stream (summary and all events
 * recorded after compaction). The untouched legacy file is also copied to a
 * versioned backup directory before either canonical file is replaced.
 *
 * Raw is written before active. If the process exits between those writes,
 * the next startup uses the immutable backup and safely retries.
 */
export function migrateLegacyCompactedConversations(): ConversationMigrationResult {
  const result: ConversationMigrationResult = { migrated: 0, skipped: 0, restoredEntries: 0 };

  for (const topic of listTopics()) {
    const fallbackAgent = topic.agent ?? "maestro";
    for (const participant of topic.participants) {
      const userId = participant.userId;
      const rawPath = getConversationPath(userId, topic.title);
      const activePath = getActiveConversationPath(userId, topic.title);
      if (!existsSync(rawPath) || existsSync(activePath)) {
        result.skipped++;
        continue;
      }

      const backupPath = join(
        resolveStorageDataDir(),
        "conversation-migration-backups",
        MIGRATION_NAME,
        userId,
        `${sanitizeTopicName(topic.title, true)}.jsonl`,
      );
      const sourcePath = existsSync(backupPath) ? backupPath : rawPath;
      const legacyEntries = readEntries(sourcePath);
      const compactIndex = compactionEntryIndex(legacyEntries);
      if (compactIndex < 0) {
        result.skipped++;
        continue;
      }

      if (!existsSync(backupPath)) {
        mkdirSync(dirname(backupPath), { recursive: true });
        copyFileSync(rawPath, backupPath);
      }

      const compactedAt = legacyEntries[compactIndex]?.ts;
      if (!compactedAt) {
        throw new Error(`conversation migration: compaction timestamp missing for ${topic.title}`);
      }
      const restored = restoreVisibleConversationEntries(
        getAllMessagesForTopic(topic.id),
        compactedAt,
        fallbackAgent,
      );
      replaceRawConversationStrict(userId, topic.title, [...restored, ...legacyEntries]);
      replaceConversationStrict(userId, topic.title, legacyEntries);

      result.migrated++;
      result.restoredEntries += restored.length;
      logger.info(
        {
          topicId: topic.id,
          topicTitle: topic.title,
          userId,
          restoredEntries: restored.length,
          legacyEntries: legacyEntries.length,
          backupPath,
        },
        "conversation storage migrated to raw/active streams",
      );
    }
  }
  return result;
}
