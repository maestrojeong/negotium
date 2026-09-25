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
import { actorReachableTopicIds } from "#runtime/actor-topic-reach";
import { sanitizeTopicName } from "#security/sanitize";
// NOTE: see `runtime.ts` — import these from `@/types` directly to keep
// `maestro-agent-sdk` (whose `bootstrapHostPath()` prints to stdout) out of
// this stdio MCP server's import graph.
import { type AgentKind, isAgentKind, type QueryState } from "#types";
import { excludesAgentlessTargets, rosterBoundsSessionTargets } from "./actor-policy";
import {
  currentTopic,
  currentTopicId,
  PLAYWRIGHT_PORTS_DIR,
  parseJsonField,
  SESSIONS_DB,
  sessionCommContext,
  userId,
  withDb,
} from "./runtime";
import {
  type SessionTarget as CatalogSessionTarget,
  createSessionTargetCatalog,
} from "./topic-catalog";

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

export type SessionTarget = CatalogSessionTarget<AgentKind>;

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
  return sessionTargetCatalog.validateTarget(to);
}

/**
 * Surface of the room this server serves, read with its own narrow query so the
 * target list below can be filtered *in SQL* rather than loaded whole and
 * filtered in memory (S-6: the store decides what a surface can see).
 */
interface CurrentPlacement {
  surface: string | undefined;
  /** Which Otium workspace owns this room; null on the single-instance surfaces. */
  surfaceScope: string | null;
}

function readCurrentPlacement(): CurrentPlacement {
  if (!existsSync(SESSIONS_DB)) return { surface: undefined, surfaceScope: null };
  try {
    return withDb((db) => {
      const row = currentTopicId
        ? (db
            .query<{ surface: string | null; surface_scope: string | null }, string>(
              "SELECT surface, surface_scope FROM api_topics WHERE id = ?",
            )
            .get(currentTopicId) ?? undefined)
        : (db
            .query<{ surface: string | null; surface_scope: string | null }, string>(
              "SELECT surface, surface_scope FROM api_topics WHERE title = ? LIMIT 1",
            )
            .get(currentTopic) ?? undefined);
      return { surface: row?.surface ?? undefined, surfaceScope: row?.surface_scope ?? null };
    });
  } catch (e) {
    process.stderr.write(`warn: session-comm: failed to read the current surface: ${e}\n`);
    return { surface: undefined, surfaceScope: null };
  }
}

interface SessionTargetRow {
  id: string;
  title: string;
  kind: string | null;
  agent: string | null;
  session_id: string | null;
  description: string | null;
  surface: string | null;
}

/**
 * Candidate target rows for a principal in a placement. Two Otium workspaces
 * share the otium surface and must still be invisible to each other (M-8),
 * so the workspace is always part of the boundary. The roster
 * (`topic_members`) is too, except on `otium` where participants are only
 * execution principals (design Q1, `rosterBoundsSessionTargets`); there the
 * catalog narrows the rows with `actorReachableTopicIds` instead.
 */
export function sessionTargetRowsFor(placement: {
  userId: string;
  surface: string | undefined;
  surfaceScope: string | null;
}): SessionTargetRow[] {
  const rosterBound = rosterBoundsSessionTargets(placement.surface) ? 1 : 0;
  return withDb((db) =>
    db
      .query<SessionTargetRow, (string | number | null)[]>(
        `SELECT t.id, t.title, t.kind, t.agent, t.session_id, t.description, t.surface
         FROM api_topics t
         WHERE (? = 0 OR EXISTS (
                 SELECT 1 FROM topic_members m WHERE m.topic_id = t.id AND m.user_id = ?))
           AND (? IS NULL OR t.surface IS NULL OR t.surface = ?)
           AND t.surface_scope IS ?`,
      )
      .all(
        rosterBound,
        placement.userId,
        placement.surface ?? null,
        placement.surface ?? null,
        placement.surfaceScope,
      ),
  );
}

function sessionTargetRows(): SessionTargetRow[] {
  if (!existsSync(SESSIONS_DB)) return [];
  try {
    const { surface, surfaceScope } = currentSessionPlacement();
    return sessionTargetRowsFor({ userId, surface, surfaceScope });
  } catch (e) {
    process.stderr.write(`warn: session-comm: failed to load topics from DB: ${e}\n`);
    return [];
  }
}

/** Canonical, deduplicated targets for display and status inspection. */
export function listSessionTargetsForUser(): SessionTarget[] {
  return sessionTargetCatalog.listTargets();
}

/** Lookup index with qualified aliases for every target and plain aliases when unambiguous. */
export function getTopicsForUser(): { [name: string]: TopicEntry } {
  return sessionTargetCatalog.getTopics();
}

/**
 * Where the room this MCP server is serving lives. Read once from the canonical
 * store: session-comm only ever addresses sessions on the same surface, and
 * within it, in the same workspace.
 */
let cachedSessionPlacement: CurrentPlacement | null = null;

function currentSessionPlacement(): CurrentPlacement {
  cachedSessionPlacement ??= readCurrentPlacement();
  return cachedSessionPlacement;
}

/** Surface of the room this server serves (undefined when it cannot be read). */
export function currentSessionSurface(): string | undefined {
  return currentSessionPlacement().surface;
}

const sessionTargetCatalog = createSessionTargetCatalog<AgentKind>({
  currentTopicId,
  currentTopicName: currentTopic,
  get currentSurface() {
    return currentSessionPlacement().surface;
  },
  get excludeAgentless() {
    return excludesAgentlessTargets(currentSessionPlacement().surface);
  },
  isAgent: isAgentKind,
  listRows: () => {
    // On `otium` the rows are the whole workspace (no roster, design Q1), so
    // the hub's per-turn assertion decides which of those rooms this actor
    // may actually name. Fail-closed without one: current room + lineage.
    // Freshness is checked here, on every listing/resolution, not at startup.
    const reachable = actorReachableTopicIds(
      {
        surface: currentSessionPlacement().surface,
        currentTopicId: currentTopicId || undefined,
        actorTopicScope: sessionCommContext.actorTopicScope,
      },
      { maxAgeMs: sessionCommContext.actorTopicScopeMaxAgeMs },
    );
    return sessionTargetRows()
      .filter((row) => !reachable || reachable.has(row.id))
      .map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        agent: row.agent,
        sessionId: row.session_id,
        description: row.description,
        surface: row.surface,
      }));
  },
});

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
