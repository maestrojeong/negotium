import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createSpawnSubagentToolDefinition,
  createSubagentManagementToolDefinitions,
  sweepStaleSubagentCards,
} from "#agents/mcp-tools/spawn-subagent";
import {
  appendApiMessage,
  deleteMessagesForTopic,
  getApiMessage,
  listApiMessagesByKind,
  updateApiMessageSubagentCard,
} from "#storage/api-messages";
import { deleteTopic, getTopic, upsertTopic } from "#storage/api-topics";
import type { MessageDto, SubagentCardDto, TopicDto } from "#types/api";

const createdTopicIds: string[] = [];

function makeTopic(userId: string, overrides: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `spawn-subagent-${randomUUID()}`,
    title: `spawn-subagent-${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    ...overrides,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

function makeCardMessage(topicId: string, card: SubagentCardDto): MessageDto {
  const msg: MessageDto = {
    id: `subagent-${card.subagentTopicId}`,
    topicId,
    authorId: "ai",
    text: `🤖 Subagent "${card.name}" spawned`,
    kind: "subagent",
    subagentCard: card,
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(msg, { notify: false });
  return msg;
}

function toolFor(topicId: string, userId: string) {
  return createSpawnSubagentToolDefinition({
    userId,
    topicId,
    queryId: `query-${randomUUID()}`,
    agent: "claude",
    model: "sonnet",
  });
}

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) {
    deleteMessagesForTopic(topicId);
    deleteTopic(topicId);
  }
});

describe("spawn_subagent guards", () => {
  test("rejects unknown topics", async () => {
    const tool = toolFor(`missing-${randomUUID()}`, "user-1");
    const result = await tool.handler({ task: "do something" });
    expect(result.isError).toBe(true);
  });

  test("rejects non-participants", async () => {
    const topic = makeTopic("owner-1");
    const tool = toolFor(topic.id, "intruder");
    const result = await tool.handler({ task: "do something" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not a member");
  });

  test("rejects channel rooms", async () => {
    const topic = makeTopic("user-1", { kind: "channel", aiMode: "mention", aiMention: true });
    const tool = toolFor(topic.id, "user-1");
    const result = await tool.handler({ task: "do something" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("agent rooms");
  });

  test("rejects subagent rooms (no recursive spawning)", async () => {
    const topic = makeTopic("user-1", { isSubagent: true, parentTopicId: "some-parent" });
    expect(getTopic(topic.id)?.isSubagent).toBe(true);
    const tool = toolFor(topic.id, "user-1");
    const result = await tool.handler({ task: "do something" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("agent rooms");
  });

  test("rejects an empty task", async () => {
    const topic = makeTopic("user-1");
    const tool = toolFor(topic.id, "user-1");
    const result = await tool.handler({ task: "   " });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("task is required");
  });

  test("rejects an oversized task", async () => {
    const topic = makeTopic("user-1");
    const tool = toolFor(topic.id, "user-1");
    const result = await tool.handler({ task: "x".repeat(9000) });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("too long");
  });

  test("rejects a model override the target agent does not support", async () => {
    const topic = makeTopic("user-1");
    const tool = toolFor(topic.id, "user-1");
    // ctx.agent is claude — "deepseek-pro" belongs to maestro.
    const result = await tool.handler({ task: "do something", model: "deepseek-pro" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not valid for agent 'claude'");
  });
});

describe("subagent management tools", () => {
  test("lists only direct subagents owned by the current user", async () => {
    const parent = makeTopic("user-1");
    const owned = makeTopic("user-1", {
      title: `owned-${randomUUID()}`,
      parentTopicId: parent.id,
      isSubagent: true,
    });
    makeTopic("user-2", {
      title: `foreign-${randomUUID()}`,
      parentTopicId: parent.id,
      isSubagent: true,
      participants: [
        { userId: "user-1", role: "member" },
        { userId: "user-2", role: "owner" },
      ],
    });

    const listTool = createSubagentManagementToolDefinitions({
      userId: "user-1",
      topicId: parent.id,
    }).find((tool) => tool.name === "list_subagents");
    expect(listTool).toBeDefined();
    const result = await listTool?.handler({});
    const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
      subagents?: Array<{ topic_id: string }>;
    };
    expect(payload.subagents?.map((child) => child.topic_id)).toEqual([owned.id]);
  });

  test("deletes an owned direct subagent and rejects unrelated topics", async () => {
    const parent = makeTopic("user-1");
    const child = makeTopic("user-1", {
      title: `child-${randomUUID()}`,
      parentTopicId: parent.id,
      isSubagent: true,
    });
    const unrelated = makeTopic("user-1", { title: `unrelated-${randomUUID()}` });
    const deleteTool = createSubagentManagementToolDefinitions({
      userId: "user-1",
      topicId: parent.id,
    }).find((tool) => tool.name === "delete_subagent");
    expect(deleteTool).toBeDefined();

    const rejected = await deleteTool?.handler({ topic_id: unrelated.id });
    expect(rejected?.isError).toBe(true);
    expect(getTopic(unrelated.id)).not.toBeNull();

    const deleted = await deleteTool?.handler({ topic_id: child.id });
    expect(deleted?.isError).toBeUndefined();
    expect(getTopic(child.id)).toBeNull();
  });
});

describe("subagent card storage", () => {
  test("subagent card round-trips through the message store", () => {
    const topic = makeTopic("user-1");
    const card: SubagentCardDto = {
      subagentTopicId: `child-${randomUUID()}`,
      name: "research-agent-1",
      task: "Investigate the flaky test",
      status: "spawned",
      startedAt: new Date().toISOString(),
    };
    const msg = makeCardMessage(topic.id, card);

    const stored = getApiMessage(topic.id, msg.id);
    expect(stored?.kind).toBe("subagent");
    expect(stored?.subagentCard).toEqual(card);

    const finishedAt = new Date().toISOString();
    const updated = updateApiMessageSubagentCard(topic.id, msg.id, {
      ...card,
      status: "completed",
      resultSummary: "Found the race in setup()",
      finishedAt,
    });
    expect(updated?.subagentCard?.status).toBe("completed");
    expect(updated?.subagentCard?.resultSummary).toBe("Found the race in setup()");
    expect(updated?.editedAt).toBeTruthy();
  });

  test("updateApiMessageSubagentCard only touches subagent-kind messages", () => {
    const topic = makeTopic("user-1");
    const plain: MessageDto = {
      id: `plain-${randomUUID()}`,
      topicId: topic.id,
      authorId: "ai",
      text: "hello",
      createdAt: new Date().toISOString(),
    };
    appendApiMessage(plain, { notify: false });
    const result = updateApiMessageSubagentCard(topic.id, plain.id, {
      subagentTopicId: "child",
      name: "x",
      task: "y",
      status: "failed",
      startedAt: new Date().toISOString(),
    });
    expect(result).toBeNull();
  });

  test("boot sweep fails in-flight cards and leaves settled ones alone", () => {
    const topic = makeTopic("user-1");
    const startedAt = new Date().toISOString();
    const running = makeCardMessage(topic.id, {
      subagentTopicId: `child-${randomUUID()}`,
      name: "runner",
      task: "long job",
      status: "running",
      startedAt,
    });
    const done = makeCardMessage(topic.id, {
      subagentTopicId: `child-${randomUUID()}`,
      name: "finisher",
      task: "short job",
      status: "completed",
      resultSummary: "done",
      startedAt,
      finishedAt: startedAt,
    });

    sweepStaleSubagentCards();

    const sweptRunning = getApiMessage(topic.id, running.id)?.subagentCard;
    expect(sweptRunning?.status).toBe("failed");
    expect(sweptRunning?.errorMessage).toContain("restarted");
    expect(getApiMessage(topic.id, done.id)?.subagentCard?.status).toBe("completed");

    const byKind = listApiMessagesByKind("subagent").filter((m) => m.topicId === topic.id);
    expect(byKind).toHaveLength(2);
  });
});
