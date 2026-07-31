import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  canSpawnSubagentsFromTopic,
  createPrepareSubagentToolDefinition,
  createSpawnSubagentToolDefinition,
  createSubagentLifecycle,
  createSubagentManagementToolDefinitions,
  type SpawnSubagentToolContext,
  type SubagentLifecycleHost,
  settleSubagentSuccess,
  sweepStaleSubagentCards,
  takeSubagentWatch,
} from "#agents/mcp-tools/spawn-subagent";
import {
  appendApiMessage,
  deleteMessagesForTopic,
  getApiMessage,
  listApiMessages,
  listApiMessagesByKind,
  updateApiMessageSubagentCard,
} from "#storage/api-messages";
import { deleteTopic, getTopic, getTopicMemoryOrigin, upsertTopic } from "#storage/api-topics";
import { claimRuntimeTurnLease, releaseRuntimeTurnLease } from "#storage/runtime-leases";
import { wikiBriefStorageKey } from "#storage/wiki-summary-names";
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

function makeInjectedLifecycleHost(parent: TopicDto) {
  const topics = new Map([[parent.id, parent]]);
  const messages = new Map<string, MessageDto>();
  const calls = {
    createDerived: 0,
    dispatch: 0,
    resolveConfig: 0,
    notifications: [] as Array<{ requestId: string; prompt: string }>,
    publishedMessages: [] as string[],
    dispatchedQueryId: "",
    placement: "",
  };
  const host: SubagentLifecycleHost<SpawnSubagentToolContext & { placement: string }> = {
    storage: {
      getTopic: (topicId) => topics.get(topicId),
      listTopics: () => [...topics.values()],
      getTopicMemoryOrigin: (topicId) => topics.get(topicId) ?? null,
      upsertTopic: (topic) => {
        topics.set(topic.id, topic);
      },
      getMessage: (topicId, messageId) => {
        const message = messages.get(messageId);
        return message?.topicId === topicId ? message : undefined;
      },
      listSubagentMessages: () =>
        [...messages.values()].filter((message) => message.kind === "subagent"),
      appendMessage: (message) => {
        messages.set(message.id, message);
      },
      updateSubagentCard: (topicId, messageId, card, editedAt) => {
        const message = messages.get(messageId);
        if (!message || message.topicId !== topicId) return null;
        const updated = { ...message, subagentCard: card, editedAt };
        messages.set(messageId, updated);
        return updated;
      },
      publishMessage: (_topicId, message) => {
        calls.publishedMessages.push(message.id);
      },
      publishCardUpdate: () => {},
    },
    topic: {
      async createDerived(input) {
        calls.createDerived += 1;
        calls.placement = input.context.placement;
        const now = new Date().toISOString();
        const child: TopicDto = {
          ...parent,
          id: `injected-child-${calls.createDerived}`,
          title: input.name ?? `injected-child-${calls.createDerived}`,
          parentTopicId: input.parentTopicId,
          isSubagent: true,
          agent: input.agent ?? parent.agent,
          defaultModel: input.model ?? parent.defaultModel,
          createdAt: now,
          lastMessageAt: now,
        };
        topics.set(child.id, child);
        return { ok: true, topic: child };
      },
      async delete(topic) {
        topics.delete(topic.id);
      },
    },
    task: {
      async dispatch(input) {
        calls.dispatch += 1;
        calls.dispatchedQueryId = `injected-query-${input.child.id}`;
        input.onDispatched(calls.dispatchedQueryId);
        return { accepted: true };
      },
    },
    sessionCommunication: {
      async notifyParent({ requestId, prompt }) {
        calls.notifications.push({ requestId, prompt });
        return true;
      },
      listTellTargetIds: () => [],
      grantTellTarget: () => {},
      revokeTellTarget: () => false,
    },
    runtime: {
      ownerId: "injected-owner",
      now: () => new Date().toISOString(),
      ownerIsAlive: () => true,
      childExecutionQueryId: () => null,
      childExecutionIsRecoverable: () => false,
    },
    config: {
      async resolveAgentModel({ model }) {
        calls.resolveConfig += 1;
        return { model };
      },
      memoryFilenames: (topic) => [`${topic.id}.md`, `${topic.title}.md`],
    },
  };
  return { host, calls, messages };
}

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) {
    deleteMessagesForTopic(topicId);
    deleteTopic(topicId);
  }
});

describe("host-injected subagent lifecycle factory", () => {
  test("routes host work through grouped boundaries and isolates watch state", async () => {
    const parent = makeTopic("user-1");
    const { host, calls, messages } = makeInjectedLifecycleHost(parent);
    const first = createSubagentLifecycle(host);
    const second = createSubagentLifecycle(host);
    const spawn = first.createSpawnSubagentToolDefinition({
      userId: "user-1",
      topicId: parent.id,
      queryId: "parent-query",
      agent: "claude",
      model: "sonnet",
      placement: "worker-1",
    });

    const result = await spawn.handler({ task: "run through the injected host", name: "worker" });
    expect(result.isError).toBeUndefined();
    expect(calls).toMatchObject({
      createDerived: 1,
      dispatch: 1,
      resolveConfig: 1,
      placement: "worker-1",
    });
    expect(calls.publishedMessages).toEqual(["subagent-injected-child-1"]);

    expect(second.takeSubagentWatch(calls.dispatchedQueryId)).toBeNull();
    const watch = first.takeSubagentWatch(calls.dispatchedQueryId);
    expect(watch).toMatchObject({
      parentTopicId: parent.id,
      childTopicId: "injected-child-1",
      queryId: calls.dispatchedQueryId,
      running: true,
    });
    expect(messages.get("subagent-injected-child-1")?.subagentCard?.status).toBe("running");

    if (!watch) return;
    await first.settleSubagentSuccess(watch, "finished");
    expect(calls.notifications).toEqual([
      {
        requestId: "subagent-done-injected-child-1",
        prompt: expect.stringContaining("finished"),
      },
    ]);
    expect(messages.get("subagent-injected-child-1")?.subagentCard?.status).toBe("completed");
  });

  test("captures and enforces caller-owned lifecycle limits", async () => {
    const parent = makeTopic("user-1");
    const { host, calls } = makeInjectedLifecycleHost(parent);
    const configuredLimits = { maxLiveChildrenPerParent: 1 };
    host.config.limits = configuredLimits;
    const lifecycle = createSubagentLifecycle(host);
    configuredLimits.maxLiveChildrenPerParent = 2;
    const spawn = lifecycle.createSpawnSubagentToolDefinition({
      userId: "user-1",
      topicId: parent.id,
      queryId: "parent-query",
      agent: "claude",
      model: "sonnet",
      placement: "worker-1",
    });

    expect((await spawn.handler({ task: "first" })).isError).toBeUndefined();
    expect((await spawn.handler({ task: "second" })).isError).toBe(true);
    expect(calls.createDerived).toBe(1);

    host.config.limits = { maxDepth: 0 };
    expect(() => createSubagentLifecycle(host)).toThrow("maxDepth must be a positive integer");
  });

  test("captures runtime owner identity when the lifecycle is created", async () => {
    const parent = makeTopic("user-1");
    const { host, messages } = makeInjectedLifecycleHost(parent);
    const lifecycle = createSubagentLifecycle(host);
    host.runtime.ownerId = "mutated-owner";
    const spawn = lifecycle.createSpawnSubagentToolDefinition({
      userId: "user-1",
      topicId: parent.id,
      queryId: "parent-query",
      agent: "claude",
      model: "sonnet",
      placement: "worker-1",
    });

    expect((await spawn.handler({ task: "capture owner" })).isError).toBeUndefined();
    expect(messages.get("subagent-injected-child-1")?.subagentCard?.runtimeOwnerId).toBe(
      "injected-owner",
    );
  });
});

describe("spawn_subagent guards", () => {
  test("exposes compact model inheritance guidance without duplicating the catalog", () => {
    const tool = toolFor(`missing-${randomUUID()}`, "user-1");
    const description = (tool.schema.model as { description?: string }).description ?? "";

    expect(description).toContain("claude/sonnet");
    expect(description).toContain("system prompt catalog");
    expect(description).not.toContain("gpt-5.6-sol");
    expect(description).not.toContain("quota cost");
  });

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

  test("allows nested subagents up to depth two", async () => {
    const root = makeTopic("user-1");
    const depth1 = makeTopic("user-1", { isSubagent: true, parentTopicId: root.id });
    const depth2 = makeTopic("user-1", { isSubagent: true, parentTopicId: depth1.id });

    expect(canSpawnSubagentsFromTopic(root.id)).toBe(true);
    expect(canSpawnSubagentsFromTopic(depth1.id)).toBe(true);
    expect(canSpawnSubagentsFromTopic(depth2.id)).toBe(false);

    const tool = toolFor(depth2.id, "user-1");
    const result = await tool.handler({ task: "do something" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("depth limit");
  });

  test("fails closed instead of looping on a cyclic parent chain", () => {
    const first = makeTopic("user-1", { isSubagent: true });
    const second = makeTopic("user-1", { isSubagent: true, parentTopicId: first.id });
    upsertTopic({ ...first, parentTopicId: second.id });

    expect(canSpawnSubagentsFromTopic(first.id)).toBe(false);
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
  test("lists only accessible effective memory topic names", async () => {
    const parent = makeTopic("user-1", { title: `parent-${randomUUID()}` });
    const knowledge = makeTopic("user-1", { title: `knowledge-${randomUUID()}` });
    makeTopic("user-1", { title: knowledge.title });
    makeTopic("other-user", { title: `private-${randomUUID()}` });
    makeTopic("user-1", {
      title: `derived-${randomUUID()}`,
      parentTopicId: knowledge.id,
    });
    const listMemoryTopics = createSubagentManagementToolDefinitions({
      userId: "user-1",
      topicId: parent.id,
    }).find((tool) => tool.name === "list_memory_topics");

    const result = await listMemoryTopics?.handler({});
    expect(result?.isError).toBeUndefined();
    const text = result?.content[0]?.text ?? "";
    expect(text).toContain(parent.title);
    expect(text).toContain(knowledge.title);
    expect(text).not.toContain("private-");
    expect(text).not.toContain("derived-");
    expect(text.split("\n").filter((name) => name === knowledge.title)).toHaveLength(1);
  });

  test("lists the owned descendant tree and renders tell connections", async () => {
    const parent = makeTopic("user-1");
    const owned = makeTopic("user-1", {
      title: `owned-${randomUUID()}`,
      parentTopicId: parent.id,
      isSubagent: true,
    });
    const grandchild = makeTopic("user-1", {
      title: `grandchild-${randomUUID()}`,
      parentTopicId: owned.id,
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
    const text = result?.content[0]?.text ?? "";
    const payload = JSON.parse(text) as {
      subagents?: Array<{ topic_id: string; tell_target_topic_ids: string[] }>;
    };
    expect(payload.subagents?.map((child) => child.topic_id)).toEqual([owned.id, grandchild.id]);
    expect(payload.subagents?.every((child) => child.tell_target_topic_ids.length === 0)).toBe(
      true,
    );
  });

  test("an ancestor can connect descendant subagents with tell grants", async () => {
    const parent = makeTopic("user-1");
    const source = makeTopic("user-1", {
      parentTopicId: parent.id,
      isSubagent: true,
    });
    const target = makeTopic("user-1", {
      parentTopicId: source.id,
      isSubagent: true,
    });
    const tools = createSubagentManagementToolDefinitions({
      userId: "user-1",
      topicId: parent.id,
    });
    const grant = tools.find((tool) => tool.name === "grant_subagent_tell");
    const listed = tools.find((tool) => tool.name === "list_subagents");

    const granted = await grant?.handler({
      subagent_topic_id: source.id,
      target_topic_id: target.id,
    });
    expect(granted?.isError).toBeUndefined();
    const listedText = (await listed?.handler({}))?.content[0]?.text ?? "";
    const listedPayload = JSON.parse(listedText) as {
      subagents?: Array<{ topic_id: string; tell_target_topic_ids: string[] }>;
    };
    const sourceEntry = listedPayload.subagents?.find((child) => child.topic_id === source.id);
    expect(sourceEntry?.tell_target_topic_ids).toEqual([target.id]);
  });

  test("a lower manager cannot revoke an ancestor grant outside its tree", async () => {
    const root = makeTopic("user-1");
    const manager = makeTopic("user-1", { parentTopicId: root.id, isSubagent: true });
    const source = makeTopic("user-1", { parentTopicId: manager.id, isSubagent: true });
    const sibling = makeTopic("user-1", { parentTopicId: root.id, isSubagent: true });
    const rootTools = createSubagentManagementToolDefinitions({
      userId: "user-1",
      topicId: root.id,
    });
    await rootTools
      .find((tool) => tool.name === "grant_subagent_tell")
      ?.handler({
        subagent_topic_id: source.id,
        target_topic_id: sibling.id,
      });

    const managerTools = createSubagentManagementToolDefinitions({
      userId: "user-1",
      topicId: manager.id,
    });
    const revoked = await managerTools
      .find((tool) => tool.name === "revoke_subagent_tell")
      ?.handler({
        subagent_topic_id: source.id,
        target_topic_id: sibling.id,
      });

    expect(revoked?.isError).toBe(true);
  });

  test("creates a prepared subagent that remains ready until started", async () => {
    const parent = makeTopic("user-1");
    const create = createPrepareSubagentToolDefinition({
      userId: "user-1",
      topicId: parent.id,
      queryId: `query-${randomUUID()}`,
      agent: "claude",
      model: "sonnet",
    });
    const created = await create.handler({
      task: "wait for the team",
      name: `prepared-${randomUUID().slice(0, 8)}`,
      report_mode: "tell",
    });
    expect(created.isError).toBeUndefined();
    const cardMessage = listApiMessagesByKind("subagent")
      .filter((message) => message.topicId === parent.id)
      .at(-1);
    const childId = cardMessage?.subagentCard?.subagentTopicId;
    expect(childId).toBeTruthy();
    if (!childId) return;
    createdTopicIds.push(childId);
    expect(cardMessage?.subagentCard).toMatchObject({ status: "ready", reportMode: "tell" });

    const tools = createSubagentManagementToolDefinitions({
      userId: "user-1",
      topicId: parent.id,
    });
    expect(tools.map((tool) => tool.name)).toContain("start_subagent");
    expect(tools.map((tool) => tool.name)).not.toContain("pause_subagent");
    expect(tools.map((tool) => tool.name)).not.toContain("resume_subagent");
  });

  test("uses the parent memory by default and accepts an explicit topic/*.md source", async () => {
    const parent = makeTopic("user-1");
    const memorySource = makeTopic("user-1", { title: `knowledge-${randomUUID()}` });
    makeTopic("user-1", { title: memorySource.title });
    const create = createPrepareSubagentToolDefinition({
      userId: "user-1",
      topicId: parent.id,
      queryId: `query-${randomUUID()}`,
      agent: "claude",
      model: "sonnet",
    });

    const inherited = await create.handler({
      task: "use parent knowledge",
      name: `parent-memory-${randomUUID().slice(0, 8)}`,
    });
    expect(inherited.isError).toBeUndefined();
    const inheritedChildId = listApiMessagesByKind("subagent")
      .filter((message) => message.topicId === parent.id)
      .at(-1)?.subagentCard?.subagentTopicId;
    expect(inheritedChildId).toBeTruthy();
    if (inheritedChildId) {
      createdTopicIds.push(inheritedChildId);
      expect(getTopic(inheritedChildId)?.memoryTopicId).toBeUndefined();
      expect(getTopicMemoryOrigin(inheritedChildId)?.id).toBe(parent.id);
    }

    const explicit = await create.handler({
      task: "use accumulated domain knowledge",
      name: `explicit-memory-${randomUUID().slice(0, 8)}`,
      memory_topic: `topic/${wikiBriefStorageKey(memorySource.title, memorySource.id)}.md`,
    });
    expect(explicit.isError).toBeUndefined();
    const explicitChildId = listApiMessagesByKind("subagent")
      .filter((message) => message.topicId === parent.id)
      .at(-1)?.subagentCard?.subagentTopicId;
    expect(explicitChildId).toBeTruthy();
    if (explicitChildId) {
      createdTopicIds.push(explicitChildId);
      expect(getTopic(explicitChildId)?.memoryTopicId).toBe(memorySource.id);
      expect(getTopicMemoryOrigin(explicitChildId)?.id).toBe(memorySource.id);
    }

    const sharedTitle = await create.handler({
      task: "use the shared title namespace",
      name: `shared-title-memory-${randomUUID().slice(0, 8)}`,
      memory_topic: memorySource.title,
    });
    expect(sharedTitle.isError).toBeUndefined();
    const sharedTitleChildId = listApiMessagesByKind("subagent")
      .filter((message) => message.topicId === parent.id)
      .at(-1)?.subagentCard?.subagentTopicId;
    expect(sharedTitleChildId).toBeTruthy();
    if (sharedTitleChildId) createdTopicIds.push(sharedTitleChildId);
  });

  test("rejects inaccessible or unsafe memory topic selectors", async () => {
    const parent = makeTopic("user-1");
    const privateSource = makeTopic("other-user");
    const create = createPrepareSubagentToolDefinition({
      userId: "user-1",
      topicId: parent.id,
      queryId: `query-${randomUUID()}`,
      agent: "claude",
      model: "sonnet",
    });

    const inaccessible = await create.handler({
      task: "read another user's memory",
      memory_topic: privateSource.id,
    });
    expect(inaccessible.isError).toBe(true);
    expect(inaccessible.content[0]?.text).toContain("not found or is not accessible");

    const traversal = await create.handler({
      task: "escape the topic directory",
      memory_topic: "topic/../secrets.md",
    });
    expect(traversal.isError).toBe(true);
    expect(traversal.content[0]?.text).toContain("under topic/");
  });

  test("deletes an owned descendant subagent and rejects unrelated topics", async () => {
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
      runtimeOwnerId: "2147483647-dead-runtime",
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

  test("boot sweep preserves cards owned by another live runtime and legacy cards", () => {
    const topic = makeTopic("user-1");
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const live = makeCardMessage(topic.id, {
      subagentTopicId: `child-${randomUUID()}`,
      name: "live-runner",
      task: "long job",
      runtimeOwnerId: `${process.pid}-other-runtime`,
      status: "running",
      startedAt,
    });
    const legacy = makeCardMessage(topic.id, {
      subagentTopicId: `child-${randomUUID()}`,
      name: "legacy-runner",
      task: "old job",
      status: "running",
      startedAt,
    });

    sweepStaleSubagentCards();

    expect(getApiMessage(topic.id, live.id)?.subagentCard?.status).toBe("running");
    expect(getApiMessage(topic.id, legacy.id)?.subagentCard?.status).toBe("running");
  });

  test("recovers a persisted watch from the child turn lease after restart", () => {
    const parent = makeTopic("user-1");
    const child = makeTopic("user-1", {
      parentTopicId: parent.id,
      isSubagent: true,
    });
    const queryId = `query-${randomUUID()}`;
    makeCardMessage(parent.id, {
      subagentTopicId: child.id,
      name: child.title,
      task: "recover me",
      runtimeOwnerId: `${process.pid}-previous-runtime`,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    expect(
      claimRuntimeTurnLease({ topicId: child.id, queryId, origin: "subagent-recovery-test" }),
    ).toBe(true);
    try {
      expect(takeSubagentWatch(queryId)).toMatchObject({
        parentTopicId: parent.id,
        childTopicId: child.id,
        userId: "user-1",
        queryId,
      });
    } finally {
      releaseRuntimeTurnLease(child.id, queryId);
    }
  });
});

describe("subagent report_mode settlement", () => {
  function watchFor(
    parent: TopicDto,
    child: TopicDto,
    reportMode: "auto" | "tell" | "status-only",
  ) {
    makeCardMessage(parent.id, {
      subagentTopicId: child.id,
      name: child.title,
      task: "settle test",
      status: "running",
      reportMode,
      startedAt: new Date().toISOString(),
    });
    return {
      parentTopicId: parent.id,
      childTopicId: child.id,
      cardMessageId: `subagent-${child.id}`,
      name: child.title,
      userId: "user-1",
      startedAt: new Date().toISOString(),
      reportMode,
      running: false,
    };
  }

  function parentSystemNotes(parentTopicId: string): MessageDto[] {
    return listApiMessages(parentTopicId).page.filter(
      (message) => message.kind === "system" && message.id.startsWith("subagent-note-"),
    );
  }

  test("auto report mode notifies the parent room on completion", async () => {
    // Agentless parent (channel/off keeps agent unset through normalization) →
    // notifyParent falls back to an observable system note instead of an AI turn.
    const parent = makeTopic("user-1", { kind: "channel", aiMode: "off", agent: undefined });
    const child = makeTopic("user-1", { parentTopicId: parent.id, isSubagent: true });
    await settleSubagentSuccess(watchFor(parent, child, "auto"), "all done");
    const notes = parentSystemNotes(parent.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toContain("all done");
    expect(getApiMessage(parent.id, `subagent-${child.id}`)?.subagentCard?.status).toBe(
      "completed",
    );
  });

  test("tell and status-only report modes never notify the parent room", async () => {
    for (const reportMode of ["tell", "status-only"] as const) {
      const parent = makeTopic("user-1", { kind: "channel", aiMode: "off", agent: undefined });
      const child = makeTopic("user-1", { parentTopicId: parent.id, isSubagent: true });
      await settleSubagentSuccess(watchFor(parent, child, reportMode), "quiet result");
      expect(parentSystemNotes(parent.id)).toHaveLength(0);
      expect(getApiMessage(parent.id, `subagent-${child.id}`)?.subagentCard?.status).toBe(
        "completed",
      );
    }
  });
});
