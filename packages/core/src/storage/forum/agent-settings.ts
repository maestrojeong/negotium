import { type AgentKind, isAgentKind } from "#types";
import { db } from "./schema";

export function getTopicAgent(userId: number, topicName: string): AgentKind {
  const row = db
    .query<{ agent: string | null }, [string, string]>(
      "SELECT agent FROM topics WHERE user_id = ? AND name = ?",
    )
    .get(String(userId), topicName);
  const value = row?.agent;
  if (!isAgentKind(value)) throw new Error(`Invalid agent in DB: ${value}`);
  return value;
}

export function setTopicAgent(userId: number, topicName: string, agent: AgentKind): boolean {
  const result = db
    .query("UPDATE topics SET agent = ? WHERE user_id = ? AND name = ?")
    .run(agent, String(userId), topicName);
  return result.changes > 0;
}
