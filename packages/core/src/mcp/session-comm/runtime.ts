/**
 * Process-bootstrap layer for the session-comm MCP server.
 *
 * Owns CLI-arg parsing, runtime constants, the shared DB helper, and
 * primitive helpers (parseJsonField, isDebugUser) that other layers
 * (`topics.ts`, `topic-config.ts`) compose on top of.
 *
 * Importers should pull *only* what they need from here; the previous
 * `utils.ts` mega-module conflated process state, topic queries, and
 * current-topic mutations in one file.
 */

import { homedir } from "node:os";
import { parseUserIdArg } from "#mcp/mcp-helpers";
import {
  PROGRESS_DIR as CONFIG_PROGRESS_DIR,
  SESSIONS_DB as CONFIG_SESSIONS_DB,
  DEBUG_FILE,
  FALLBACK_AGENT,
  PLAYWRIGHT_PORTS_DIR,
  SESSION_INBOX_DIR,
  SESSION_WORKSPACE_DIR,
} from "#platform/config";
import { readJsonFile } from "#platform/jsonl";
import { Database } from "#storage/sqlite";
import type { AgentKind } from "#types";
// NOTE: import from "#types" — NOT "@/agents". The agents barrel re-exports
// `maestroProvider`, which transitively pulls in `maestro-agent-sdk`. That SDK
// runs `bootstrapHostPath()` at module-load and writes `[log] env-bootstrap…`
// to *stdout* via its default console logger. Because this MCP server speaks
// JSON-RPC over stdio, any rogue stdout write corrupts the channel and codex's
// rmcp parser (`serde error expected value at line 1 column 2`) drops every
// tool on this server. Pulling these symbols straight from `@/types` keeps the
// SDK out of the import graph.
import { isAgentKind } from "#types";

export { PLAYWRIGHT_PORTS_DIR, SESSION_INBOX_DIR };

// --- Constants & CLI args ---

export const HOME = homedir();
export const SESSIONS_DB = CONFIG_SESSIONS_DB;
export const PROGRESS_DIR = CONFIG_PROGRESS_DIR;

const args = process.argv.slice(2);
export const userId = parseUserIdArg(args);
export const currentTopic = args.find((a) => a.startsWith("--topic="))?.split("=")[1] || "";
export const currentTopicId =
  args.find((a) => a.startsWith("--topic-id="))?.slice("--topic-id=".length) || "";
export const currentDepth = Number(
  args.find((a) => a.startsWith("--depth="))?.split("=")[1] ?? "0",
);
// When true, the session is a silent fork generating an ask_session reply —
// outbound tools (ask_session/tell_session/abort_session) are not registered.
export const isReplyOnly = args.includes("--reply-only=true");
const _agentArg = args.find((a) => a.startsWith("--agent="))?.split("=")[1];
if (_agentArg !== undefined && !isAgentKind(_agentArg)) {
  throw new Error(`Invalid --agent arg: ${_agentArg}`);
}
export const currentAgent: AgentKind = _agentArg ?? FALLBACK_AGENT;

// Max tell_session relay depth — env parse/기본값 로직은 @/platform/config 로 이동.
export { MAX_TELL_DEPTH } from "#platform/config";
export const MAX_MESSAGE_LENGTH = 10_000;
export const USER_CWD = SESSION_WORKSPACE_DIR;

// --- DB helper ---

export function withDb<T>(
  fn: (db: InstanceType<typeof Database>) => T,
  opts?: { write?: boolean },
): T {
  const db = new Database(SESSIONS_DB, opts?.write ? undefined : { readonly: true });
  try {
    db.exec(opts?.write ? "PRAGMA busy_timeout = 5000" : "PRAGMA busy_timeout = 3000");
    if (opts?.write) db.exec("PRAGMA journal_mode = WAL");
    return fn(db);
  } finally {
    db.close();
  }
}

export const isManagerTopic = currentTopicId
  ? withDb((db) => {
      const row = db.query("SELECT kind FROM api_topics WHERE id = ?").get(currentTopicId) as
        | { kind?: string }
        | undefined;
      return row?.kind === "manager";
    })
  : false;

// --- JSON field parser helper (shared by topics.ts + topic-config.ts) ---

export function parseJsonField<T>(value: string | null | undefined, label: string): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (e) {
    process.stderr.write(`warn: session-comm: failed to parse ${label}: ${e}\n`);
    return undefined;
  }
}

// --- Debug helper ---

let _isDebugUser: boolean | undefined;
export function isDebugUser(): boolean {
  if (_isDebugUser !== undefined) return _isDebugUser;
  const users = readJsonFile<number[]>(DEBUG_FILE);
  _isDebugUser = !!users?.includes(Number(userId));
  return _isDebugUser;
}
