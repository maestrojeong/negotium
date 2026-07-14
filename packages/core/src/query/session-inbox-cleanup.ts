import { unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { SESSION_INBOX_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import { scheduledSessionInboxPath, sessionInboxPath } from "#query/session-inbox-path";

/**
 * Delete pending, scheduled, and crash-claimed inbox files for a topic.
 * Canonical files are id-keyed; title-keyed candidates cover rolling upgrades.
 */
export function cleanupSessionInboxFiles(
  userId: string,
  topicId: string,
  legacyTopicTitle?: string,
): number {
  const live = sessionInboxPath(userId, topicId);
  const scheduled = scheduledSessionInboxPath(userId, topicId);
  const candidates = new Set([live, `${live}.processing`, scheduled, `${scheduled}.processing`]);

  if (
    legacyTopicTitle &&
    legacyTopicTitle !== "." &&
    legacyTopicTitle !== ".." &&
    basename(legacyTopicTitle) === legacyTopicTitle
  ) {
    const legacyBase = join(SESSION_INBOX_DIR, userId, legacyTopicTitle);
    for (const suffix of [".jsonl", ".jsonl.processing", ".schedule", ".schedule.processing"]) {
      candidates.add(`${legacyBase}${suffix}`);
    }
  }

  let deleted = 0;
  for (const path of candidates) {
    try {
      unlinkSync(path);
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn({ err, path, topicId, userId }, "topic cleanup: inbox unlink failed");
      }
    }
  }
  return deleted;
}
