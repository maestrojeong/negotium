import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "#platform/logger";
import { sanitizeTopicName } from "#security/sanitize";
import { getAllMessagesForTopic, getMessagesForTopicAfterRowid } from "#storage/api-messages";
import { formatTopicArchiveTranscriptRecord } from "#storage/topic-transcript";
import { getSharedWikiDir } from "#storage/wiki";

export interface TopicArchiveResult {
  path: string;
  messageCount: number;
  lastRowid: number;
}

export interface TopicArchiveOptions {
  afterRowid?: number;
  reason?: "delete" | "idle";
}

/**
 * Forensic-archive a topic's SQLite-backed messages into the shared
 * `wiki/archive/` as JSONL transcript records.
 *
 * Otium keeps conversations in the `api_messages` table (SQLite), not in the
 * `PROJECT_ROOT/logs` activity-log files that Otium's `archiveSessionLogs`
 * scans — so this is Otium's native equivalent. Each JSONL record keeps the raw
 * DB message under `message`, plus a human-readable `line`/`role`/`speaker` for
 * the background wiki-archiver turn.
 *
 * Output lands in the **shared** wiki root (see `getSharedWikiDir`) because
 * that is the root the wiki MCP serves in topic-id mode; writing it elsewhere
 * would make the archive invisible to later `wiki_query` calls.
 *
 * Returns `null` when the selected range has no messages.
 */
export function archiveTopicMessages(
  topicId: string,
  topicTitle: string,
  options: TopicArchiveOptions = {},
): TopicArchiveResult | null {
  const rows =
    options.afterRowid !== undefined
      ? getMessagesForTopicAfterRowid(topicId, options.afterRowid)
      : getAllMessagesForTopic(topicId);
  if (rows.length === 0) return null;

  const safeTopic = sanitizeTopicName(topicTitle, true);
  const archiveDir = join(getSharedWikiDir(), "archive");
  mkdirSync(archiveDir, { recursive: true });

  // Collision-proof file name: a topic deleted twice on the same day (e.g.
  // recreated then deleted again) must not clobber the earlier archive.
  const date = new Date().toISOString().slice(0, 10);
  const reasonSuffix = options.reason === "idle" ? "_idle" : "";
  let filename = `${safeTopic}_${date}${reasonSuffix}.jsonl`;
  let counter = 1;
  while (existsSync(join(archiveDir, filename))) {
    counter++;
    filename = `${safeTopic}_${date}${reasonSuffix}_${counter}.jsonl`;
  }
  const path = join(archiveDir, filename);
  const lastRowid = rows.reduce((max, row) => Math.max(max, row.rowid ?? 0), 0);

  const body = `${rows
    .map((r, index) => JSON.stringify(formatTopicArchiveTranscriptRecord(r, topicTitle, index + 1)))
    .join("\n")}\n`;
  writeFileSync(path, body);

  logger.info(
    { topicId, topicTitle, archive: path, messageCount: rows.length, lastRowid },
    "archiveTopicMessages: archived topic messages",
  );
  return { path, messageCount: rows.length, lastRowid };
}
