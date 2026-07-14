/**
 * Mutations and reads scoped to the *current* topic (the one this MCP server
 * was spawned for). Splitting these out from `topics.ts` keeps read-only,
 * cross-topic queries separate from writes that only make sense for
 * `currentTopic`.
 */
import { existsSync } from "node:fs";
import { OPTIONAL_FORUM_MCP_SERVERS, REQUIRED_FORUM_MCP_SERVERS } from "#platform/mcp-config";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import { getTopic, getTopicByNameForUser } from "#storage/api-topics";
import {
  currentTopic,
  currentTopicId,
  parseJsonField,
  SESSIONS_DB,
  userId,
  withDb,
} from "./runtime";

function currentApiTopicId(): string | null {
  if (!userId) return null;
  if (currentTopicId) {
    try {
      const topic = getTopic(currentTopicId);
      if (!topic) {
        process.stderr.write(`warn: session-comm: api topic id not found: ${currentTopicId}\n`);
        return null;
      }
      if (!topic.participants.some((p) => p.userId === userId)) {
        process.stderr.write(
          `warn: session-comm: user ${userId} is not a participant of topic id ${currentTopicId}\n`,
        );
        return null;
      }
      return topic.id;
    } catch (e) {
      process.stderr.write(`warn: session-comm: api topic id lookup failed: ${e}\n`);
      return null;
    }
  }
  if (!currentTopic) return null;
  try {
    return getTopicByNameForUser(currentTopic, userId)?.id ?? null;
  } catch (e) {
    process.stderr.write(`warn: session-comm: api topic lookup failed: ${e}\n`);
    return null;
  }
}

function normalizeMcpEnabled(enabled: string[] | null): string[] | undefined {
  if (enabled === null) return undefined;
  const requested = [...new Set(enabled.map((n) => n.trim()).filter(Boolean))];
  const invalid = requested.filter(
    (n) => !OPTIONAL_FORUM_MCP_SERVERS.includes(n) && !REQUIRED_FORUM_MCP_SERVERS.includes(n),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown MCP server(s): ${invalid.join(", ")}. Optional servers are: ${OPTIONAL_FORUM_MCP_SERVERS.join(", ")}.`,
    );
  }
  return requested.filter((n) => OPTIONAL_FORUM_MCP_SERVERS.includes(n));
}

export function getMcpConfig(): { enabled: string[] | null; extra: Record<string, unknown> } {
  const apiTopicId = currentApiTopicId();
  if (apiTopicId) {
    return { enabled: getApiTopicConfig(apiTopicId)?.mcp ?? [], extra: {} };
  }

  if (!existsSync(SESSIONS_DB)) return { enabled: null, extra: {} };
  try {
    return withDb((db) => {
      const row = db
        .query<{ mcp_enabled: string | null; mcp_extra: string | null }, [string, string]>(
          "SELECT mcp_enabled, mcp_extra FROM topics WHERE user_id = ? AND name = ?",
        )
        .get(userId, currentTopic);
      const enabled =
        parseJsonField<string[] | null>(
          row?.mcp_enabled,
          `mcp_enabled for topic "${currentTopic}"`,
        ) ?? null;
      const extra =
        parseJsonField<Record<string, unknown>>(
          row?.mcp_extra,
          `mcp_extra for topic "${currentTopic}"`,
        ) ?? {};
      return { enabled, extra };
    });
  } catch (e) {
    process.stderr.write(`warn: session-comm: getMcpConfig DB query failed: ${e}\n`);
    return { enabled: null, extra: {} };
  }
}

export function setCurrentTopicDescription(description: string) {
  withDb(
    (db) => {
      db.query("UPDATE topics SET description = ? WHERE user_id = ? AND name = ?").run(
        description,
        userId,
        currentTopic,
      );
    },
    { write: true },
  );
}

export function setMcpConfig(enabled?: string[] | null) {
  const apiTopicId = currentApiTopicId();
  if (apiTopicId) {
    if (enabled !== undefined) {
      const existing = getApiTopicConfig(apiTopicId) ?? {};
      setApiTopicConfig(apiTopicId, { ...existing, mcp: normalizeMcpEnabled(enabled) });
    }
    return;
  }

  withDb(
    (db) => {
      if (enabled !== undefined) {
        db.query("UPDATE topics SET mcp_enabled = ? WHERE user_id = ? AND name = ?").run(
          enabled !== null ? JSON.stringify(enabled) : null,
          userId,
          currentTopic,
        );
      }
    },
    { write: true },
  );
}
