import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { USERS_LOG_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import { sanitizeId } from "#security/sanitize";
import type { QueryState } from "#types";

type QueryStateUserId = number | string;

function queryStateDirPath(userId: QueryStateUserId): string {
  return join(USERS_LOG_DIR, String(userId), "active-queries");
}

function queryStateFile(userId: QueryStateUserId, topicId: string): string {
  return join(queryStateDirPath(userId), `${sanitizeId(topicId)}.json`);
}

function legacyQueryStateFile(
  userId: QueryStateUserId,
  topicName: string | undefined,
): string | null {
  if (!topicName || topicName === "." || topicName === ".." || basename(topicName) !== topicName) {
    return null;
  }
  return join(queryStateDirPath(userId), `${topicName}.json`);
}

export function writeQueryState(
  userId: QueryStateUserId,
  topicId: string,
  topicName: string,
  task?: string,
) {
  const dir = queryStateDirPath(userId);
  mkdirSync(dir, { recursive: true });
  const state: QueryState = { topicId, topicName, since: new Date().toISOString() };
  if (task) state.task = [...task.replace(/\n+/g, " ").trim()].slice(0, 100).join("");
  const target = queryStateFile(userId, topicId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, target);
}

export function clearQueryState(
  userId: QueryStateUserId,
  topicId: string,
  legacyTopicName?: string,
) {
  const paths = [
    queryStateFile(userId, topicId),
    legacyQueryStateFile(userId, legacyTopicName),
  ].filter((path): path is string => Boolean(path));
  for (const path of new Set(paths)) {
    try {
      unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn({ err: e, userId, topicId, path }, "Failed to clear query state file");
      }
    }
  }
}
