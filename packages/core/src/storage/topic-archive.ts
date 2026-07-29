import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countMemoryArchiveExchanges } from "#agents/memory-archive-policy";
import { logger } from "#platform/logger";
import { sanitizeTopicName } from "#security/sanitize";
import { getAllMessagesForTopic, getMessagesForTopicAfterRowid } from "#storage/api-messages";
import { readRawConversation } from "#storage/conversations";
import { formatTopicArchiveTranscriptRecord } from "#storage/topic-transcript";
import { getSharedWikiDir } from "#storage/wiki";
import type { UnifiedEvent } from "#types";

export interface TopicArchiveResult {
  path: string;
  messageCount: number;
  exchangeCount: number;
  lastRowid: number;
}

export interface ConversationEventArchiveResult {
  path: string;
  eventCount: number;
}

export interface TopicArchiveOptions {
  afterRowid?: number;
  reason?: "delete" | "idle" | "reset";
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
  const reasonSuffix = options.reason && options.reason !== "delete" ? `_${options.reason}` : "";
  let filename: string;
  let counter = 1;
  const lastRowid = rows.reduce((max, row) => Math.max(max, row.rowid ?? 0), 0);
  const body = `${rows
    .map((r, index) => JSON.stringify(formatTopicArchiveTranscriptRecord(r, topicTitle, index + 1)))
    .join("\n")}\n`;
  let path: string;
  while (true) {
    filename = `${safeTopic}_${date}${reasonSuffix}${counter === 1 ? "" : `_${counter}`}.jsonl`;
    path = join(archiveDir, filename);
    try {
      writeFileSync(path, body, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      counter++;
    }
  }

  const exchangeCount = countMemoryArchiveExchanges(rows);
  logger.info(
    { topicId, topicTitle, archive: path, messageCount: rows.length, exchangeCount, lastRowid },
    "archiveTopicMessages: archived topic messages",
  );
  return { path, messageCount: rows.length, exchangeCount, lastRowid };
}

function eventText(event: UnifiedEvent): string {
  if ("content" in event && typeof event.content === "string") return event.content;
  if (event.type === "session") return `sessionId: ${event.sessionId}`;
  if (event.type === "tool_use") {
    return `${event.name}(${JSON.stringify(event.input)})`;
  }
  if (event.type === "tool_progress") return `${event.toolName} · ${event.elapsed}s`;
  if (event.type === "tool_use_summary") return event.summary;
  if (event.type === "file") return `${event.path} (${event.source})`;
  return JSON.stringify(event);
}

function eventSpeaker(event: UnifiedEvent, agent: string): string {
  if (event.type === "user_message") return "user";
  if (event.type === "tool_use" || event.type === "tool_result") return `tool:${agent}`;
  if (event.type === "reasoning") return `reasoning:${agent}`;
  if (event.type === "session") return `session:${agent}`;
  return `assistant:${agent}`;
}

/**
 * Preserve the append-only provider-neutral event stream before topic teardown.
 * Unlike the visible transcript this includes tools, reasoning, errors, and
 * every provider session id across agent switches and compactions.
 */
export function archiveConversationEvents(
  topicId: string,
  topicTitle: string,
  userId: string,
  options: Pick<TopicArchiveOptions, "reason"> = {},
): ConversationEventArchiveResult | null {
  const entries = readRawConversation(userId, topicTitle);
  if (entries.length === 0) return null;

  const archiveDir = join(getSharedWikiDir(), "archive");
  mkdirSync(archiveDir, { recursive: true });
  const safeTopic = sanitizeTopicName(topicTitle, true);
  const date = new Date().toISOString().slice(0, 10);
  const reasonSuffix = options.reason && options.reason !== "delete" ? `_${options.reason}` : "";
  const body = `${entries
    .map((entry, index) => {
      const text = eventText(entry.event);
      const speaker = eventSpeaker(entry.event, entry.agent);
      return JSON.stringify({
        type: "event",
        index: index + 1,
        topicId,
        topicTitle,
        createdAt: entry.ts,
        role: entry.event.type === "user_message" ? "user" : "assistant",
        speaker,
        line: `[${entry.ts}] ${speaker}: ${text.replace(/\s+/g, " ").trim().slice(0, 2000)}`,
        text,
        agent: entry.agent,
        eventType: entry.event.type,
        event: entry.event,
      });
    })
    .join("\n")}\n`;

  let counter = 1;
  while (true) {
    const suffix = counter === 1 ? "" : `_${counter}`;
    const path = join(archiveDir, `${safeTopic}_${date}${reasonSuffix}_events${suffix}.jsonl`);
    try {
      writeFileSync(path, body, { flag: "wx" });
      logger.info(
        { topicId, topicTitle, archive: path, eventCount: entries.length },
        "archiveConversationEvents: archived raw conversation events",
      );
      return { path, eventCount: entries.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      counter++;
    }
  }
}
