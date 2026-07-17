import { type AgentKind, isAgentKind } from "#types";
import {
  db,
  type ForumTopicInfo,
  logger,
  rowToTopic,
  type TopicRow,
  type UserForumConfig,
  type UserRow,
} from "./schema";

function defaultSessionAgent(): AgentKind {
  for (const value of [
    process.env.SESSION_AGENT?.trim(),
    process.env.FALLBACK_AGENT?.trim(),
    process.env.DEFAULT_AGENT?.trim(),
  ]) {
    if (isAgentKind(value)) return value;
  }
  return "maestro";
}

export function getUserConfig(userId: number): UserForumConfig | null {
  const user = db.query<UserRow, string>("SELECT * FROM users WHERE id = ?").get(String(userId));
  if (!user) return null;

  const topicRows = db
    .query<TopicRow, string>("SELECT * FROM topics WHERE user_id = ?")
    .all(String(userId));
  const topics: { [name: string]: ForumTopicInfo } = {};
  for (const row of topicRows) topics[row.name] = rowToTopic(row);

  return {
    ...(user.dm_session_id && { dmSessionId: user.dm_session_id }),
    ...(user.communicate_thread_id != null && { communicateThreadId: user.communicate_thread_id }),
    topics,
  };
}

export function getTopicByName(userId: number, name: string): ForumTopicInfo | null {
  const row = db
    .query<TopicRow, [string, string]>("SELECT * FROM topics WHERE user_id = ? AND name = ?")
    .get(String(userId), name);
  return row ? rowToTopic(row) : null;
}

export function findUserByThread(
  threadId: number,
): { userId: number; topic: ForumTopicInfo } | null {
  const row = db
    .query<TopicRow, number>("SELECT * FROM topics WHERE message_thread_id = ?")
    .get(threadId);
  if (!row) return null;
  return { userId: Number(row.user_id), topic: rowToTopic(row) };
}

export function getSessionForTopic(userId: number, topicName: string): string | null {
  const row = db
    .query<{ session_id: string | null }, [string, string]>(
      "SELECT session_id FROM topics WHERE user_id = ? AND name = ?",
    )
    .get(String(userId), topicName);
  return row?.session_id || null;
}

export function getTopicNames(userId: number): string[] {
  const rows = db
    .query<{ name: string }, string>("SELECT name FROM topics WHERE user_id = ?")
    .all(String(userId));
  return rows.map((r) => r.name);
}

export function getAllTopics(userId: number): ForumTopicInfo[] {
  const rows = db
    .query<TopicRow, string>("SELECT * FROM topics WHERE user_id = ?")
    .all(String(userId));
  return rows.map(rowToTopic);
}

export function getAllUserIds(): number[] {
  const rows = db.query<{ id: string }, []>("SELECT id FROM users").all();
  return rows.map((r) => Number(r.id)).filter((n) => !Number.isNaN(n));
}

export function getCommunicateThreadId(userId: number): number | null {
  const row = db
    .query<{ communicate_thread_id: number | null }, string>(
      "SELECT communicate_thread_id FROM users WHERE id = ?",
    )
    .get(String(userId));
  return row?.communicate_thread_id ?? null;
}

export function getDmSessionId(userId: number): string | null {
  const row = db
    .query<{ dm_session_id: string | null }, string>("SELECT dm_session_id FROM users WHERE id = ?")
    .get(String(userId));
  return row?.dm_session_id ?? null;
}

export function getTopicDescription(userId: number, topicName: string): string | null {
  const row = db
    .query<{ description: string | null }, [string, string]>(
      "SELECT description FROM topics WHERE user_id = ? AND name = ?",
    )
    .get(String(userId), topicName);
  return row?.description || null;
}

export function getTopicMcpConfig(
  userId: number,
  topicName: string,
): { enabled: string[] | null; extra: Record<string, unknown> } {
  const row = db
    .query<{ mcp_enabled: string | null; mcp_extra: string | null }, [string, string]>(
      "SELECT mcp_enabled, mcp_extra FROM topics WHERE user_id = ? AND name = ?",
    )
    .get(String(userId), topicName);
  let enabled: string[] | null = null;
  let extra: Record<string, unknown> = {};
  try {
    if (row?.mcp_enabled) enabled = JSON.parse(row.mcp_enabled);
  } catch (e) {
    logger.warn({ err: e }, "getTopicMcpConfig: failed to parse mcp_enabled");
  }
  try {
    if (row?.mcp_extra) extra = JSON.parse(row.mcp_extra);
  } catch (e) {
    logger.warn({ err: e }, "getTopicMcpConfig: failed to parse mcp_extra");
  }
  return { enabled, extra };
}

export function addTopic(
  userId: number,
  name: string,
  messageThreadId: number,
  sessionId?: string,
  createdAt?: string,
): boolean {
  if (name.startsWith("__")) {
    logger.warn({ name }, "addTopic: refusing reserved __ prefix");
    return false;
  }
  db.query("INSERT OR IGNORE INTO users (id) VALUES (?)").run(String(userId));
  db.query(`
    INSERT INTO topics (user_id, name, message_thread_id, session_id, created_at, agent)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      message_thread_id = excluded.message_thread_id,
      session_id = COALESCE(excluded.session_id, topics.session_id),
      created_at = excluded.created_at
  `).run(
    String(userId),
    name,
    messageThreadId,
    sessionId ?? null,
    createdAt ?? new Date().toISOString(),
    defaultSessionAgent(),
  );
  return true;
}

export function renameTopic(
  userId: number,
  oldName: string,
  newName: string,
): { ok: true } | { ok: false; reason: "not_found" | "name_taken" } {
  if (oldName === newName) return { ok: true };
  if (getTopicByName(userId, newName)) return { ok: false, reason: "name_taken" };
  const result = db
    .prepare("UPDATE topics SET name = ? WHERE user_id = ? AND name = ?")
    .run(newName, String(userId), oldName);
  if (result.changes === 0) return { ok: false, reason: "not_found" };
  return { ok: true };
}

export function removeTopic(userId: number, name: string) {
  db.query("DELETE FROM topics WHERE user_id = ? AND name = ?").run(String(userId), name);
}

export function setSessionForTopic(userId: number, topicName: string, sessionId: string) {
  db.query("UPDATE topics SET session_id = ? WHERE user_id = ? AND name = ?").run(
    sessionId,
    String(userId),
    topicName,
  );
}

export function clearSessionForTopic(userId: number, topicName: string) {
  db.query("UPDATE topics SET session_id = NULL WHERE user_id = ? AND name = ?").run(
    String(userId),
    topicName,
  );
}

export function setDmSessionId(userId: number, sessionId: string) {
  db.query(`
    INSERT INTO users (id, dm_session_id) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET dm_session_id = excluded.dm_session_id
  `).run(String(userId), sessionId);
}

export function clearDmSessionId(userId: number) {
  db.query("UPDATE users SET dm_session_id = NULL WHERE id = ?").run(String(userId));
}

export function setTopicDescription(
  userId: number,
  topicName: string,
  description: string,
): boolean {
  const result = db
    .query("UPDATE topics SET description = ? WHERE user_id = ? AND name = ?")
    .run(description, String(userId), topicName);
  return result.changes > 0;
}

export function getLastShownConfig(
  userId: number,
  topicName: string,
): { agent: AgentKind | null; model: string | null; effort: string | null } | null {
  type LastShownRow = {
    last_shown_agent: string | null;
    last_shown_model: string | null;
    last_shown_effort: string | null;
  };
  const row = db
    .query<LastShownRow, [string, string]>(
      "SELECT last_shown_agent, last_shown_model, last_shown_effort FROM topics WHERE user_id = ? AND name = ?",
    )
    .get(String(userId), topicName);
  if (!row) return null;
  const agent =
    row.last_shown_agent && isAgentKind(row.last_shown_agent) ? row.last_shown_agent : null;
  return { agent, model: row.last_shown_model, effort: row.last_shown_effort };
}

export function setLastShownConfig(
  userId: number,
  topicName: string,
  agent: AgentKind,
  model: string,
  effort: string | undefined,
): boolean {
  const result = db
    .query(
      "UPDATE topics SET last_shown_agent = ?, last_shown_model = ?, last_shown_effort = ? WHERE user_id = ? AND name = ?",
    )
    .run(agent, model, effort ?? null, String(userId), topicName);
  return result.changes > 0;
}

export function setTopicForkOrigin(userId: number, topicName: string, origin: string): boolean {
  const result = db
    .query("UPDATE topics SET fork_origin = ? WHERE user_id = ? AND name = ?")
    .run(origin, String(userId), topicName);
  return result.changes > 0;
}

export function updateTopicThreadId(
  userId: number,
  topicName: string,
  newThreadId: number,
): boolean {
  const result = db
    .query("UPDATE topics SET message_thread_id = ? WHERE user_id = ? AND name = ?")
    .run(newThreadId, String(userId), topicName);
  return result.changes > 0;
}

export function setTopicMcpEnabled(
  userId: number,
  topicName: string,
  enabled: string[] | null,
): boolean {
  const value = enabled !== null ? JSON.stringify(enabled) : null;
  const result = db
    .query("UPDATE topics SET mcp_enabled = ? WHERE user_id = ? AND name = ?")
    .run(value, String(userId), topicName);
  return result.changes > 0;
}

export function setTopicMcpExtra(
  userId: number,
  topicName: string,
  extra: Record<string, unknown>,
): boolean {
  const result = db
    .query("UPDATE topics SET mcp_extra = ? WHERE user_id = ? AND name = ?")
    .run(JSON.stringify(extra), String(userId), topicName);
  return result.changes > 0;
}
