import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import {
  deleteTopic,
  getTopic,
  getTopicSessionId,
  listTopics,
  normalizeTopicState,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import { db } from "#storage/forum-db";
import type { TopicDto } from "#types/api";

const createdTopicIds: string[] = [];

function makeTopic(id = `topic-${randomUUID()}`): TopicDto {
  const now = new Date().toISOString();
  return {
    id,
    title: `Topic ${randomUUID().slice(0, 8)}`,
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMention: false,
    participants: [{ userId: "owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  };
}

afterEach(() => {
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

describe("api topic storage", () => {
  test("uses the canonical topic and membership schema", () => {
    const topicColumns = (
      db.query("PRAGMA table_info(api_topics)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const memberColumns = (
      db.query("PRAGMA table_info(topic_members)").all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(topicColumns).toContain("agent");
    expect(topicColumns).toContain("response_policy");
    expect(topicColumns).toContain("base_model");
    expect(topicColumns).not.toContain("runtime_agent");
    expect(topicColumns).not.toContain("participants");
    expect(topicColumns).not.toContain("ai_mention");
    expect(topicColumns).not.toContain("is_archived");
    expect(memberColumns).toEqual(["topic_id", "user_id", "role"]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("upsertTopic preserves the durable AI session id on metadata updates", () => {
    const topic = makeTopic();
    createdTopicIds.push(topic.id);
    upsertTopic(topic);
    setTopicSessionId(topic.id, "session-1");

    upsertTopic({
      ...topic,
      title: "Renamed topic",
      description: "metadata-only update",
      lastMessageAt: new Date().toISOString(),
    });

    expect(getTopicSessionId(topic.id)).toBe("session-1");
  });

  test("listTopics hydrates participants for every topic", () => {
    const first = makeTopic();
    const second = makeTopic();
    first.participants.push({ userId: "member-1", role: "member" });
    second.participants.push({ userId: "member-2", role: "member" });
    createdTopicIds.push(first.id, second.id);
    upsertTopic(first);
    upsertTopic(second);

    const listed = new Map(listTopics().map((topic) => [topic.id, topic]));

    expect(listed.get(first.id)?.participants).toEqual(first.participants);
    expect(listed.get(second.id)?.participants).toEqual(second.participants);
  });

  test("manager rooms stay manager/always while preserving their chosen agent", () => {
    expect(normalizeTopicState({ kind: "manager", agent: "codex", aiMode: "off" })).toEqual({
      kind: "manager",
      aiMode: "always",
      agent: "codex",
    });
  });

  test("deleteTopic refuses to delete General", () => {
    if (!getTopic(GENERAL_TOPIC_ID)) {
      upsertTopic({
        ...makeTopic(GENERAL_TOPIC_ID),
        title: "General",
        agent: "maestro",
      });
    }

    expect(deleteTopic(GENERAL_TOPIC_ID)).toBe(false);
    expect(getTopic(GENERAL_TOPIC_ID)).toMatchObject({
      id: GENERAL_TOPIC_ID,
      kind: "manager",
      aiMode: "always",
      aiMention: false,
      agent: "maestro",
    });
  });

  test("deleteTopic protects UUID-based personal manager rooms", () => {
    const topic = makeTopic();
    topic.kind = "manager";
    topic.agent = "maestro";
    createdTopicIds.push(topic.id);
    upsertTopic(topic);

    expect(deleteTopic(topic.id)).toBe(false);
    expect(getTopic(topic.id)?.kind).toBe("manager");
    expect(deleteTopic(topic.id, { allowManager: true })).toBe(true);
  });
});
