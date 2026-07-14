import { join } from "node:path";
import { SESSION_INBOX_DIR } from "#platform/config";

const TOPIC_ID_FILE_PREFIX = "topic-id-";
const JSONL_SUFFIX = ".jsonl";
const SCHEDULE_SUFFIX = ".schedule";

/** Build a flat inbox path from the canonical topic id, never its title. */
export function sessionInboxPath(userId: string, topicId: string): string {
  const key = Buffer.from(topicId, "utf8").toString("base64url");
  return join(SESSION_INBOX_DIR, userId, `${TOPIC_ID_FILE_PREFIX}${key}${JSONL_SUFFIX}`);
}

/** Durable sidecar consumed by the session-inbox worker once deliverAt passes. */
export function scheduledSessionInboxPath(userId: string, topicId: string): string {
  const key = Buffer.from(topicId, "utf8").toString("base64url");
  return join(SESSION_INBOX_DIR, userId, `${TOPIC_ID_FILE_PREFIX}${key}${SCHEDULE_SUFFIX}`);
}

function decodeTopicIdFileName(fileName: string, suffix: string): string | null {
  if (!fileName.startsWith(TOPIC_ID_FILE_PREFIX) || !fileName.endsWith(suffix)) return null;
  const encoded = fileName.slice(TOPIC_ID_FILE_PREFIX.length, -suffix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

/** Null denotes a legacy `{topicTitle}.jsonl` filename from an older runtime. */
export function topicIdFromSessionInboxFileName(fileName: string): string | null {
  return decodeTopicIdFileName(fileName, JSONL_SUFFIX);
}

/** Accept both a live .schedule file and a crash-residue .schedule.processing claim. */
export function topicIdFromScheduledSessionInboxFileName(fileName: string): string | null {
  const base = fileName.endsWith(".processing")
    ? fileName.slice(0, -".processing".length)
    : fileName;
  return decodeTopicIdFileName(base, SCHEDULE_SUFFIX);
}
