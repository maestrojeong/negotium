import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  deleteApiTopicConfig,
  getApiTopicConfig,
  setApiTopicConfig,
} from "#storage/api-topic-config";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";

const topicIds: string[] = [];

function topicId(): string {
  const id = `cfg-${randomUUID()}`;
  topicIds.push(id);
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: id,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId: "config-test", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  return id;
}

afterEach(() => {
  for (const id of topicIds.splice(0)) {
    deleteApiTopicConfig(id);
    deleteTopic(id);
  }
});

describe("api topic config", () => {
  test("uses lock names and contains no duplicated agent column", () => {
    const columns = (
      db.query("PRAGMA table_info(api_topic_config)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual([
      "topic_id",
      "model",
      "effort",
      "mcp",
      "agent_locked",
      "model_locked",
      "effort_locked",
    ]);
  });

  test("fresh topics have no overrides", () => {
    const id = topicId();
    expect(getApiTopicConfig(id)).toBeUndefined();
  });

  test("stores model config without duplicating the topic agent", () => {
    const id = topicId();
    setApiTopicConfig(id, {
      model: "gpt-5.6-sol",
      effort: "high",
      agentLocked: true,
      modelLocked: true,
    });

    expect(getApiTopicConfig(id)).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
      agentLocked: true,
      modelLocked: true,
    });
  });
});
