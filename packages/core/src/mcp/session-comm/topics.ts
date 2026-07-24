/**
 * Topic-level data access for the session-comm MCP server.
 *
 * All read-only DB queries that return topic entities live here. Mutations
 * against the *current* topic belong in `topic-config.ts`; runtime/CLI
 * concerns belong in `runtime.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionInboxPath } from "#query/session-inbox-path";
import { sanitizeTopicName } from "#security/sanitize";
// NOTE: see `runtime.ts` — import these from `@/types` directly to keep
// `maestro-agent-sdk` (whose `bootstrapHostPath()` prints to stdout) out of
// this stdio MCP server's import graph.
import { type AgentKind, isAgentKind, type QueryState } from "#types";
import {
  currentTopic,
  currentTopicId,
  PLAYWRIGHT_PORTS_DIR,
  parseJsonField,
  SESSIONS_DB,
  userId,
  withDb,
} from "./runtime";

export type { QueryState };

// --- Topic entry types ---

export interface TopicEntry {
  sessionId: string;
  messageThreadId: number;
  name: string;
  kind: "agent" | "channel";
  description?: string;
  /** api_topics id (UUID) — delivery target for tell/ask. */
  topicId?: string;
  /** REST topics can be human-only. ask_session/tell_session require an AI target. */
  agent?: AgentKind;
}

export interface SessionTarget {
  key: string;
  topic: TopicEntry;
}

export interface McpTopicEntry {
  sessionId: string;
  messageThreadId: number;
  name: string;
  createdAt: string;
  description?: string;
  agent: AgentKind;
  mcpEnabled?: string[] | null;
  mcpExtra?: Record<string, unknown>;
}

export interface McpUserConfig {
  dmSessionId?: string;
  topics: { [name: string]: McpTopicEntry };
}

export type ValidateTargetResult =
  | { ok: true; target: TopicEntry }
  | { ok: false; error: { content: Array<{ type: "text"; text: string }>; isError: true } };

// --- Queries ---

export function validateTarget(to: string): ValidateTargetResult {
  const topics = getTopicsForUser();
  const target = topics[to];
  if (!target) {
    const available = Object.entries(topics)
      .filter(([name, topic]) => name !== currentTopic && Boolean(topic.agent))
      .map(([name]) => name);
    return {
      ok: false,
      error: {
        content: [
          {
            type: "text" as const,
            text: `Error: Session "${to}" not found.\nAvailable: ${available.join(", ") || "none"}`,
          },
        ],
        isError: true,
      },
    };
  }
  // Topics without an active session (sessionId === "") are still valid
  // targets — ask_session / tell_session deliveries will wake them with a
  // fresh session via the session-inbox worker. See `session-inbox.ts`.
  return { ok: true, target };
}

function sessionTargetRows(): Array<{
  id: string;
  title: string;
  kind: string | null;
  agent: string | null;
  session_id: string | null;
  description: string | null;
}> {
  if (!existsSync(SESSIONS_DB)) return [];
  try {
    return withDb((db) => {
      return db
        .query<
          {
            id: string;
            title: string;
            kind: string | null;
            agent: string | null;
            session_id: string | null;
            description: string | null;
          },
          string
        >(
          `SELECT t.id, t.title, t.kind, t.agent, t.session_id, t.description
           FROM api_topics t
           INNER JOIN topic_members m ON m.topic_id = t.id
           WHERE m.user_id = ?`,
        )
        .all(userId);
    });
  } catch (e) {
    process.stderr.write(`warn: session-comm: failed to load topics from DB: ${e}\n`);
    return [];
  }
}

/** Canonical, deduplicated targets for display and status inspection. */
export function listSessionTargetsForUser(): SessionTarget[] {
  const eligibleRows = sessionTargetRows().filter((row) => row.kind !== "manager");
  const titleCounts = new Map<string, number>();
  for (const row of eligibleRows) {
    const normalized = row.title.toLowerCase();
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
  }
  const rows = eligibleRows.filter((row) =>
    currentTopicId ? row.id !== currentTopicId : row.title !== currentTopic,
  );
  return rows.map((row) => {
    const agent = isAgentKind(row.agent) ? row.agent : undefined;
    const kind = row.kind === "agent" ? "agent" : "channel";
    const topic: TopicEntry = {
      sessionId: row.session_id ?? "",
      messageThreadId: 0,
      name: row.title,
      kind,
      topicId: row.id,
      ...(agent && { agent }),
      ...(row.description && { description: row.description }),
    };
    const collision = (titleCounts.get(row.title.toLowerCase()) ?? 0) > 1;
    return { key: collision ? `${kind}:${row.title}` : row.title, topic };
  });
}

/** Lookup index with qualified aliases for every target and plain aliases when unambiguous. */
export function getTopicsForUser(): { [name: string]: TopicEntry } {
  const result: { [name: string]: TopicEntry } = {};
  for (const { key, topic } of listSessionTargetsForUser()) {
    result[`${topic.kind}:${topic.name}`] = topic;
    result[key] = topic;
  }
  return result;
}

export function getMcpUserConfig(): McpUserConfig | null {
  if (!existsSync(SESSIONS_DB)) return null;
  try {
    return withDb((db) => {
      const user = db
        .query<{ dm_session_id: string | null }, string>(
          "SELECT dm_session_id FROM users WHERE id = ?",
        )
        .get(userId);
      if (!user) return null;
      const dmSessionId = user.dm_session_id;

      const topicRows = db
        .query<
          {
            name: string;
            message_thread_id: number;
            session_id: string | null;
            created_at: string;
            description: string | null;
            agent: string | null;
            mcp_enabled: string | null;
            mcp_extra: string | null;
          },
          string
        >(
          "SELECT name, message_thread_id, session_id, created_at, description, agent, mcp_enabled, mcp_extra FROM topics WHERE user_id = ?",
        )
        .all(userId);

      const topics: { [name: string]: McpTopicEntry } = {};
      for (const row of topicRows) {
        const mcpEnabled = parseJsonField<string[] | null>(
          row.mcp_enabled,
          `mcp_enabled for "${row.name}"`,
        );
        const mcpExtra = parseJsonField<Record<string, unknown>>(
          row.mcp_extra,
          `mcp_extra for "${row.name}"`,
        );
        if (!isAgentKind(row.agent)) throw new Error(`Invalid agent in DB: ${row.agent}`);
        const agent: AgentKind = row.agent;
        topics[row.name] = {
          name: row.name,
          messageThreadId: row.message_thread_id,
          sessionId: row.session_id ?? "",
          createdAt: row.created_at,
          agent,
          ...(row.description && { description: row.description }),
          ...(mcpEnabled !== undefined && { mcpEnabled }),
          ...(mcpExtra !== undefined && { mcpExtra }),
        };
      }

      return {
        ...(dmSessionId && { dmSessionId }),
        topics,
      };
    });
  } catch (e) {
    process.stderr.write(`warn: session-comm: getMcpUserConfig failed: ${e}\n`);
    return null;
  }
}

/**
 * Build the session-inbox jsonl path.
 */
export function buildInboxPath(targetTopicId: string): string {
  return sessionInboxPath(userId, targetTopicId);
}

/** Look up the playwright SSE port for the target topic from the port file */
export function getPlaywrightPort(topic: string): number | null {
  if (!userId || !topic) return null;
  const safeTopicName = sanitizeTopicName(topic);
  const portFile = join(PLAYWRIGHT_PORTS_DIR, `${userId}_${safeTopicName}`);
  try {
    const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}
