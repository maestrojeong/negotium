import { join } from "node:path";
import { SESSION_INBOX_DIR } from "#platform/config";

const TOPIC_ID_FILE_PREFIX = "topic-id-";
const JSONL_SUFFIX = ".jsonl";

/** Build a flat inbox path from the canonical topic id, never its title. */
export function sessionInboxPath(userId: string, topicId: string): string {
  const key = Buffer.from(topicId, "utf8").toString("base64url");
  return join(SESSION_INBOX_DIR, userId, `${TOPIC_ID_FILE_PREFIX}${key}${JSONL_SUFFIX}`);
}

/** Null denotes a legacy `{topicTitle}.jsonl` filename from an older runtime. */
export function topicIdFromSessionInboxFileName(fileName: string): string | null {
  if (!fileName.startsWith(TOPIC_ID_FILE_PREFIX) || !fileName.endsWith(JSONL_SUFFIX)) return null;
  const encoded = fileName.slice(TOPIC_ID_FILE_PREFIX.length, -JSONL_SUFFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}
