import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { USERS_LOG_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import { sanitizeId } from "#security/sanitize";
import type { QueryState } from "#types";

type QueryStateUserId = number | string;

export interface QueryStateStoreLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface QueryStateStoreOptions {
  usersLogDir: string;
  logger?: QueryStateStoreLogger;
  sanitizeTopicId?: (topicId: string) => string;
}

export interface QueryStateStore {
  write(userId: QueryStateUserId, topicId: string, topicName: string, task?: string): void;
  clear(userId: QueryStateUserId, topicId: string, legacyTopicName?: string): void;
}

export function createQueryStateStore(options: QueryStateStoreOptions): QueryStateStore {
  const sanitize = options.sanitizeTopicId ?? sanitizeId;
  const queryStateDirPath = (userId: QueryStateUserId): string =>
    join(options.usersLogDir, String(userId), "active-queries");
  const queryStateFile = (userId: QueryStateUserId, topicId: string): string =>
    join(queryStateDirPath(userId), `${sanitize(topicId)}.json`);
  const legacyQueryStateFile = (
    userId: QueryStateUserId,
    topicName: string | undefined,
  ): string | null => {
    if (
      !topicName ||
      topicName === "." ||
      topicName === ".." ||
      basename(topicName) !== topicName
    ) {
      return null;
    }
    return join(queryStateDirPath(userId), `${topicName}.json`);
  };

  return {
    write(userId, topicId, topicName, task) {
      const dir = queryStateDirPath(userId);
      mkdirSync(dir, { recursive: true });
      const state: QueryState = { topicId, topicName, since: new Date().toISOString() };
      if (task) state.task = [...task.replace(/\n+/g, " ").trim()].slice(0, 100).join("");
      const target = queryStateFile(userId, topicId);
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, target);
    },
    clear(userId, topicId, legacyTopicName) {
      const paths = [
        queryStateFile(userId, topicId),
        legacyQueryStateFile(userId, legacyTopicName),
      ].filter((path): path is string => Boolean(path));
      for (const path of new Set(paths)) {
        try {
          unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
            options.logger?.warn(
              { err: error, userId, topicId, path },
              "Failed to clear query state file",
            );
          }
        }
      }
    },
  };
}

const defaultQueryStateStore = createQueryStateStore({
  usersLogDir: USERS_LOG_DIR,
  logger,
});

export function writeQueryState(
  userId: QueryStateUserId,
  topicId: string,
  topicName: string,
  task?: string,
) {
  defaultQueryStateStore.write(userId, topicId, topicName, task);
}

export function clearQueryState(
  userId: QueryStateUserId,
  topicId: string,
  legacyTopicName?: string,
) {
  defaultQueryStateStore.clear(userId, topicId, legacyTopicName);
}
