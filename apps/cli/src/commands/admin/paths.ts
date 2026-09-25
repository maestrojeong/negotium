/**
 * The node's filesystem layout, computed with the same precedence as core's
 * `#platform/config` — WITHOUT importing core. Importing core creates the
 * state tree (including `<data>/uploads` next to the sessions DB), mints
 * secrets and opens the DB; a report or dry-run must do none of that.
 * `tests/admin*.test.ts` asserts that every path here equals core's own.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

function envText(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function stateChild(env: NodeJS.ProcessEnv, key: string, stateDir: string, name: string): string {
  const value = envText(env, key);
  return value ? resolve(value) : resolve(stateDir, name);
}

/** Mirror of core `safeRuntimePathSegment` (config-helpers.ts). */
export function safeRuntimePathSegment(value: string, fallback: string, maxLength = 160): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  return cleaned || fallback;
}

export interface NodePaths {
  stateDir: string;
  dataDir: string;
  sessionsDb: string;
  uploadsDir: string;
  runDir: string;
  sessionInboxDir: string;
  sessionAsksDir: string;
  topicWorkspaceDir: string;
  nodeDaemonInfo: string;
}

export function nodePaths(env: NodeJS.ProcessEnv = process.env): NodePaths {
  const configured = envText(env, "NEGOTIUM_STATE_DIR");
  const stateDir = configured ? resolve(configured) : resolve(homedir(), ".negotium");
  const dataDir = stateChild(env, "NEGOTIUM_DATA_DIR", stateDir, "data");
  const runDir = stateChild(env, "NEGOTIUM_RUN_DIR", stateDir, "runtime");
  const workspaceDir = stateChild(env, "NEGOTIUM_WORKSPACE_DIR", stateDir, "workspace");
  return {
    stateDir,
    dataDir,
    sessionsDb: env.SESSIONS_DB_PATH
      ? resolve(env.SESSIONS_DB_PATH)
      : resolve(dataDir, "sessions.db"),
    uploadsDir: resolve(dataDir, "uploads"),
    runDir,
    sessionInboxDir: resolve(runDir, "session-inbox"),
    sessionAsksDir: join(runDir, "session-asks"),
    topicWorkspaceDir: resolve(workspaceDir, "topics"),
    nodeDaemonInfo: resolve(runDir, "node-daemon.json"),
  };
}

/** Mirror of core `resolveTopicWorkspaceDir`. */
export function topicWorkspaceDir(paths: NodePaths, topicId: string): string {
  return join(paths.topicWorkspaceDir, safeRuntimePathSegment(topicId, "topic"));
}

const TOPIC_ID_FILE_PREFIX = "topic-id-";

/** Mirror of core `sessionInboxPath` / `scheduledSessionInboxPath` (+ `.processing`). */
export function sessionInboxFiles(paths: NodePaths, userId: string, topicId: string): string[] {
  const key = Buffer.from(topicId, "utf8").toString("base64url");
  const live = join(paths.sessionInboxDir, userId, `${TOPIC_ID_FILE_PREFIX}${key}.jsonl`);
  const scheduled = join(paths.sessionInboxDir, userId, `${TOPIC_ID_FILE_PREFIX}${key}.schedule`);
  return [live, `${live}.processing`, scheduled, `${scheduled}.processing`];
}

/** Legacy title-keyed inbox files (core `cleanupSessionInboxFiles`). */
export function legacySessionInboxFiles(paths: NodePaths, userId: string, title: string): string[] {
  if (!title || title === "." || title === ".." || title.includes("/")) return [];
  const base = join(paths.sessionInboxDir, userId, title);
  return [".jsonl", ".jsonl.processing", ".schedule", ".schedule.processing"].map(
    (suffix) => `${base}${suffix}`,
  );
}

/** Mirror of core `pendingAskDir` (session-asks.ts). */
export function pendingAskDir(paths: NodePaths, userId: string): string {
  const safe =
    /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,255}$/.test(userId) && !userId.includes("..")
      ? userId
      : `sha256-${new Bun.CryptoHasher("sha256").update(userId).digest("hex")}`;
  return join(paths.sessionAsksDir, safe);
}
