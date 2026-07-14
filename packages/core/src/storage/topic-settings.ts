import { db } from "#storage/forum-db";
import { type AgentKind, isAgentKind } from "#types";

export interface TopicAgentSwitchState {
  name: string;
  agent: AgentKind;
}

function toTopicAgentSwitchState(row: {
  name: string;
  agent: string | null;
}): TopicAgentSwitchState {
  if (!isAgentKind(row.agent)) throw new Error(`Invalid agent in DB: ${row.agent}`);
  return {
    name: row.name,
    agent: row.agent,
  };
}

export function getTopicAgentSwitchState(
  userId: number,
  topicName: string,
): TopicAgentSwitchState | null {
  const row = db
    .query<{ name: string; agent: string | null }, [string, string]>(
      "SELECT name, agent FROM topics WHERE user_id = ? AND name = ?",
    )
    .get(String(userId), topicName);
  return row ? toTopicAgentSwitchState(row) : null;
}

export interface SetTopicAgentAndSessionOptions {
  userId: number;
  topicName: string;
  agent: AgentKind;
  sessionId: string;
}

export function setTopicAgentAndSession(opts: SetTopicAgentAndSessionOptions): void {
  const { userId, topicName, agent, sessionId } = opts;
  db.transaction(() => {
    const r = db
      .query("UPDATE topics SET agent = ?, session_id = ? WHERE user_id = ? AND name = ?")
      .run(agent, sessionId, String(userId), topicName);
    if (r.changes === 0) {
      throw new Error(`setTopicAgentAndSession: row missing for ${userId}/${topicName}`);
    }
  })();
}

export interface SetTopicAgentAndClearSessionOptions {
  userId: number;
  topicName: string;
  agent: AgentKind;
}

export function setTopicAgentAndClearSession(opts: SetTopicAgentAndClearSessionOptions): boolean {
  const { userId, topicName, agent } = opts;
  let changed = false;
  db.transaction(() => {
    const r = db
      .query("UPDATE topics SET agent = ?, session_id = NULL WHERE user_id = ? AND name = ?")
      .run(agent, String(userId), topicName);
    changed = r.changes > 0;
  })();
  return changed;
}
