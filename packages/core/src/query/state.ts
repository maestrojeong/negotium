import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_QUERY_STALE_MS, USERS_LOG_DIR } from "#platform/config";
import { readJsonFile } from "#platform/jsonl";
import { logger } from "#platform/logger";
import type { QueryState } from "#types";

type QueryStateUserId = number | string;

function queryStateDirPath(userId: QueryStateUserId): string {
  return join(USERS_LOG_DIR, String(userId), "active-queries");
}

function queryStateFile(userId: QueryStateUserId, topicName: string): string {
  const name = `${topicName}.json`;
  return join(queryStateDirPath(userId), name);
}

export function writeQueryState(userId: QueryStateUserId, topicName: string, task?: string) {
  const dir = queryStateDirPath(userId);
  mkdirSync(dir, { recursive: true });
  const state: QueryState = { since: new Date().toISOString() };
  if (task) state.task = [...task.replace(/\n+/g, " ").trim()].slice(0, 100).join("");
  const target = queryStateFile(userId, topicName);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, target);
}

export function clearQueryState(userId: QueryStateUserId, topicName: string) {
  try {
    unlinkSync(queryStateFile(userId, topicName));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn({ err: e, userId, topicName }, "Failed to clear query state file");
    }
  }
}

export function cleanStaleQueryStates(allowedUserIds: Set<number>) {
  const now = Date.now();
  try {
    const userDirs = readdirSync(USERS_LOG_DIR, { withFileTypes: true });
    for (const dir of userDirs) {
      if (!dir.isDirectory()) continue;
      const userId = Number(dir.name);
      if (!Number.isFinite(userId) || !allowedUserIds.has(userId)) continue;
      const stateDir = join(USERS_LOG_DIR, dir.name, "active-queries");
      let files: string[];
      try {
        files = readdirSync(stateDir);
      } catch (e) {
        logger.warn({ err: e, stateDir }, "cleanStaleQueryStates: failed to read state dir");
        continue;
      }
      for (const file of files) {
        const filePath = join(stateDir, file);
        try {
          if (file.endsWith(".lock") || file.endsWith(".tmp")) {
            try {
              unlinkSync(filePath);
            } catch (e) {
              logger.warn(
                { err: e, filePath },
                "cleanStaleQueryStates: failed to remove legacy file",
              );
            }
            logger.info({ filePath }, "Removed legacy lock/tmp file");
            continue;
          }
          if (file.endsWith(".json")) {
            const state = readJsonFile<QueryState>(filePath);
            const stale = !state || now - new Date(state.since).getTime() > ACTIVE_QUERY_STALE_MS;
            if (stale) {
              try {
                unlinkSync(filePath);
              } catch (e) {
                logger.warn(
                  { err: e, filePath },
                  "cleanStaleQueryStates: failed to remove stale state file",
                );
              }
              logger.info({ filePath }, "Removed stale query state file");
            }
          }
        } catch {
          /* ignore individual file errors */
        }
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "cleanStaleQueryStates: failed");
  }
}
