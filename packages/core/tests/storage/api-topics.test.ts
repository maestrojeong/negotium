import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import {
  deleteTopic,
  findTopicTitleConflict,
  getTopic,
  getTopicMemoryOrigin,
  getTopicSessionId,
  grantSubagentTellTarget,
  listTopics,
  normalizeTopicState,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { getVisibleTopics } from "#topics/derive";
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
    const topicIndexes = (
      db.query("PRAGMA index_list(api_topics)").all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(topicColumns).toContain("agent");
    expect(topicColumns).toContain("response_policy");
    expect(topicColumns).toContain("base_model");
    expect(topicColumns).toContain("visibility");
    expect(topicColumns).toContain("surface");
    // Retired by the surface migration: a room reaches Otium by living there.
    expect(topicColumns).not.toContain("access_mode");
    expect(topicColumns).toContain("subagent_report_mode");
    expect(topicColumns).toContain("memory_topic_id");
    expect(topicColumns).toContain("memory_key");
    expect(topicColumns).not.toContain("runtime_agent");
    expect(topicColumns).not.toContain("participants");
    expect(topicColumns).not.toContain("ai_mention");
    expect(topicColumns).not.toContain("is_archived");
    expect(topicIndexes).toContain("idx_api_topics_last_message");
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

  test("hydrates explicit tell targets for subagent topics", () => {
    const parent = makeTopic();
    const child = {
      ...makeTopic(),
      isSubagent: true,
      parentTopicId: parent.id,
    };
    const target = makeTopic();
    createdTopicIds.push(parent.id, child.id, target.id);
    upsertTopic(parent);
    upsertTopic(child);
    upsertTopic(target);
    grantSubagentTellTarget(child.id, target.id, parent.id);

    expect(getTopic(child.id)?.subagentTellTargetIds).toEqual([target.id]);
    expect(getTopic(parent.id)?.subagentTellTargetIds).toBeUndefined();
  });

  test("persists a subagent report mode for graph and authorization clients", () => {
    const parent = makeTopic();
    const child = {
      ...makeTopic(),
      isSubagent: true,
      parentTopicId: parent.id,
      subagentReportMode: "status-only" as const,
    };
    createdTopicIds.push(parent.id, child.id);
    upsertTopic(parent);
    upsertTopic(child);

    expect(getTopic(child.id)?.subagentReportMode).toBe("status-only");
  });

  test("persists an explicit memory topic and resolves it ahead of the parent chain", () => {
    const parent = makeTopic();
    const memorySource = makeTopic();
    const child = {
      ...makeTopic(),
      isSubagent: true,
      parentTopicId: parent.id,
      memoryTopicId: memorySource.id,
    };
    createdTopicIds.push(parent.id, memorySource.id, child.id);
    upsertTopic(parent);
    upsertTopic(memorySource);
    upsertTopic(child);

    expect(getTopic(child.id)?.memoryTopicId).toBe(memorySource.id);
    expect(getTopicMemoryOrigin(child.id)?.id).toBe(memorySource.id);
  });

  test("persists a canonical title-keyed memory namespace", () => {
    const topic = makeTopic("memory-key");
    createdTopicIds.push(topic.id);
    topic.memoryKey = "persona";
    upsertTopic(topic);

    expect(getTopic(topic.id)?.memoryKey).toBe("persona");
  });

  test("persists explicit topic visibility while defaulting ordinary topics to visible", () => {
    const visible = makeTopic();
    const hidden = { ...makeTopic(), visibility: "hidden" as const };
    createdTopicIds.push(visible.id, hidden.id);
    upsertTopic(visible);
    upsertTopic(hidden);

    expect(getTopic(visible.id)?.visibility).toBe("visible");
    expect(getTopic(hidden.id)?.visibility).toBe("hidden");
    expect(getVisibleTopics().some((topic) => topic.id === visible.id)).toBe(true);
    expect(getVisibleTopics().some((topic) => topic.id === hidden.id)).toBe(false);
  });

  test("defaults topics to the terminal surface and persists an explicit one", () => {
    const local = makeTopic();
    const hub = { ...makeTopic(), surface: "otium" as const };
    createdTopicIds.push(local.id, hub.id);
    upsertTopic(local);
    upsertTopic(hub);

    expect(getTopic(local.id)?.surface).toBe("terminal");
    expect(getTopic(hub.id)?.surface).toBe("otium");
  });

  test("lists only the requested surface", () => {
    const local = makeTopic();
    const hub = { ...makeTopic(), surface: "otium" as const };
    createdTopicIds.push(local.id, hub.id);
    upsertTopic(local);
    upsertTopic(hub);

    const terminalIds = listTopics({ surface: "terminal" }).map((topic) => topic.id);
    const otiumIds = listTopics({ surface: "otium" }).map((topic) => topic.id);
    expect(terminalIds).toContain(local.id);
    expect(terminalIds).not.toContain(hub.id);
    expect(otiumIds).toContain(hub.id);
    expect(otiumIds).not.toContain(local.id);
  });

  test("the same title may exist once per surface", () => {
    const title = `surface-dup-${randomUUID().slice(0, 8)}`;
    const local = { ...makeTopic(), title };
    const hub = { ...makeTopic(), title, surface: "otium" as const };
    createdTopicIds.push(local.id, hub.id);
    upsertTopic(local);
    upsertTopic(hub);

    expect(findTopicTitleConflict(title, "agent", { surface: "terminal" })?.id).toBe(local.id);
    expect(findTopicTitleConflict(title, "agent", { surface: "otium" })?.id).toBe(hub.id);
    expect(findTopicTitleConflict(title, "agent", { surface: "telegram" })).toBeNull();
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
