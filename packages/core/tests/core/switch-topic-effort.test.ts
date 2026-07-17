import { afterEach, describe, expect, test } from "bun:test";
import { switchTopicEffort } from "#application/switch-topic-effort";
import { deleteApiTopicConfig, getApiTopicConfig } from "#storage/api-topic-config";
import {
  deleteTopic,
  getTopicSessionId,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";

const USER = "switch-topic-effort-test-user";
const createdTopicIds: string[] = [];

function seedTopic(): string {
  const id = `switch-effort-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `Switch Effort ${id}`,
    kind: "agent",
    agent: "codex",
    aiMode: "always",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    participants: [{ userId: USER, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  createdTopicIds.push(id);
  return id;
}

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) {
    deleteApiTopicConfig(topicId);
    deleteTopic(topicId);
  }
});

describe("topic effort picker", () => {
  test("persists and locks the selected effort without resetting the session", () => {
    const topicId = seedTopic();
    setTopicSessionId(topicId, "existing-session", { reason: "test", agent: "codex" });

    const result = switchTopicEffort({ topicId, userId: USER, effort: "high" });

    expect(result).toEqual({
      ok: true,
      effort: "high",
      text: "Effort set to 'high'. Applies from the next turn.",
    });
    expect(getApiTopicConfig(topicId)).toMatchObject({ effort: "high", effortLocked: true });
    expect(getTopicSessionId(topicId)).toBe("existing-session");
  });

  test("rejects non-owners and invalid runtime values", () => {
    const topicId = seedTopic();
    expect(switchTopicEffort({ topicId, userId: "other", effort: "high" })).toEqual({
      ok: false,
      error: "Only topic owners can change the effort",
    });
    expect(switchTopicEffort({ topicId, userId: USER, effort: "invalid" })).toEqual({
      ok: false,
      error: "Unknown effort: invalid",
    });
  });
});
