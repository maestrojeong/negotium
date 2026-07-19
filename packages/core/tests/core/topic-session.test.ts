import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { nextUsageAlert } from "#runtime/usage-alert";
import { appendApiMessage, getAllMessagesForTopic } from "#storage/api-messages";
import { deleteTopic, getTopic, getTopicSessionId, setTopicSessionId } from "#storage/api-topics";
import {
  appendConversationEventStrict,
  readConversation,
  replaceConversationStrict,
} from "#storage/conversations";
import { claimRuntimeTurnLease, releaseRuntimeTurnLease } from "#storage/runtime-leases";
import {
  enqueueRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";
import { registerTopic } from "#topics/create";
import { compactTopicSession, restartTopicSession } from "#topics/session";

const createdTopicIds = new Set<string>();

function createTopic(owner = `owner-${randomUUID()}`) {
  const topic = registerTopic({
    title: `reset-${randomUUID()}`,
    userId: owner,
    agent: "codex",
  });
  createdTopicIds.add(topic.id);
  return { owner, topic };
}

afterEach(() => {
  for (const topicId of createdTopicIds) deleteTopic(topicId);
  createdTopicIds.clear();
});

describe("restartTopicSession", () => {
  test("archives memory before purging provider context", async () => {
    const { owner, topic } = createTopic();
    const sessionId = "01940000-0000-7000-8000-000000000099";
    setTopicSessionId(topic.id, sessionId, { reason: "test", agent: "codex" });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "remember before reset",
    });
    let archived = false;

    const result = await restartTopicSession(topic.id, owner, "test-reset", {
      archiveMemory: (topicId, userId, options) => {
        expect(topicId).toBe(topic.id);
        expect(userId).toBe(owner);
        expect(options).toMatchObject({
          reason: "reset",
          minMessages: 1,
          allowMentionOnly: true,
          skipBusyCheck: true,
        });
        expect(getTopicSessionId(topic.id)).toBe(sessionId);
        expect(readConversation(owner, topic.title)).toHaveLength(1);
        archived = true;
        return "archived";
      },
      purgeLogs: async () => {
        expect(archived).toBe(true);
        replaceConversationStrict(owner, topic.title, []);
      },
    });

    expect(result.isError).toBeUndefined();
    expect(archived).toBe(true);
    expect(readConversation(owner, topic.title)).toEqual([]);
  });

  test("clears runtime context while preserving the topic and visible history owner", async () => {
    const { owner, topic } = createTopic();
    setTopicSessionId(topic.id, "01940000-0000-7000-8000-000000000000", {
      reason: "test",
      agent: "codex",
    });
    expect(
      nextUsageAlert(owner, topic.id, topic.title, {
        inputTokens: 1_100_000,
        outputTokens: 0,
        contextTokens: 90_000,
        contextWindow: 100_000,
      }),
    ).not.toBeNull();

    const result = await restartTopicSession(topic.id, owner, "test-reset");

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("next message starts fresh");
    expect(getTopic(topic.id)).not.toBeNull();
    expect(getTopicSessionId(topic.id)).toBeNull();
    expect(
      nextUsageAlert(owner, topic.id, topic.title, {
        inputTokens: 1_100_000,
        outputTokens: 0,
        contextTokens: 90_000,
        contextWindow: 100_000,
      }),
    ).not.toBeNull();
  });

  test("rejects non-owners without clearing the current session", async () => {
    const { topic } = createTopic();
    setTopicSessionId(topic.id, "current-session", { reason: "test", agent: "codex" });

    const result = await restartTopicSession(topic.id, "not-the-owner");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("owner");
    expect(getTopicSessionId(topic.id)).toBe("current-session");
  });

  test("cancels durable work queued before reset", async () => {
    const { owner, topic } = createTopic();
    enqueueRuntimeUserTurnRequest({
      topicId: topic.id,
      userId: owner,
      prompt: "must not run against the reset session",
      allowAutoContinue: true,
    });
    expect(getRuntimeUserTurnRequest(topic.id)).not.toBeNull();

    const result = await restartTopicSession(topic.id, owner);

    expect(result.isError).toBeUndefined();
    expect(getRuntimeUserTurnRequest(topic.id)).toBeNull();
  });

  test("waits for a turn owned by another standalone process before purging context", async () => {
    const { owner, topic } = createTopic();
    const remoteOwner = `remote-${randomUUID()}`;
    const queryId = `query-${randomUUID()}`;
    setTopicSessionId(topic.id, "remote-session", { reason: "test", agent: "codex" });
    expect(
      claimRuntimeTurnLease({
        topicId: topic.id,
        queryId,
        origin: "user",
        ownerId: remoteOwner,
      }),
    ).toBe(true);
    const releaseTimer = setTimeout(() => {
      releaseRuntimeTurnLease(topic.id, queryId, remoteOwner);
    }, 25);

    try {
      const result = await restartTopicSession(topic.id, owner);

      expect(result.isError).toBeUndefined();
      expect(getTopicSessionId(topic.id)).toBeNull();
    } finally {
      clearTimeout(releaseTimer);
      releaseRuntimeTurnLease(topic.id, queryId, remoteOwner);
    }
  });

  test("resets a personal General manager room", async () => {
    const { owner, topic } = createTopic();
    topic.kind = "manager";
    topic.title = "General";
    const { upsertTopic } = await import("#storage/api-topics");
    upsertTopic(topic);
    setTopicSessionId(topic.id, "personal-general-session", {
      reason: "test",
      agent: "codex",
    });

    const result = await restartTopicSession(topic.id, owner);

    expect(result.isError).toBeUndefined();
    expect(result.text).toBe('Session reset for "General". The next message starts fresh.');
    expect(getTopicSessionId(topic.id)).toBeNull();
  });
});

describe("compactTopicSession", () => {
  test("replaces provider context with a summary while preserving visible messages", async () => {
    const { owner, topic } = createTopic();
    const oldSessionId = "01940000-0000-7000-8000-000000000001";
    setTopicSessionId(topic.id, oldSessionId, { reason: "test", agent: "codex" });
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: owner,
      text: "keep the visible user request",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: "ai",
      text: "keep the visible assistant reply",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "original provider request",
    });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "result",
      content: "original provider reply",
      stopReason: "end_turn",
    });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "session",
      sessionId: oldSessionId,
    });

    let source = "";
    const result = await compactTopicSession(topic.id, owner, "test-compact", {
      summarize: async (request) => {
        source = request.source;
        return "Standalone compact summary with decisions and next steps.";
      },
    });

    expect(result.isError).toBeUndefined();
    expect(source).toContain("keep the visible user request");
    expect(source).toContain("keep the visible assistant reply");
    expect(getAllMessagesForTopic(topic.id).map((message) => message.text)).toEqual([
      "keep the visible user request",
      "keep the visible assistant reply",
    ]);
    const compacted = readConversation(owner, topic.title);
    expect(compacted.map((entry) => entry.event.type)).toEqual([
      "user_message",
      "result",
      "session",
    ]);
    expect(compacted[1]?.event).toMatchObject({
      type: "result",
      content: "Standalone compact summary with decisions and next steps.",
    });
    expect(getTopicSessionId(topic.id)).not.toBe(oldSessionId);

    await restartTopicSession(topic.id, owner, "test-compact-cleanup", {
      archiveMemory: () => "below-threshold",
    });
  });

  test("keeps the existing provider context when summarization fails", async () => {
    const { owner, topic } = createTopic();
    const oldSessionId = "01940000-0000-7000-8000-000000000002";
    setTopicSessionId(topic.id, oldSessionId, { reason: "test", agent: "codex" });
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: owner,
      text: "do not lose this",
      createdAt: new Date().toISOString(),
    });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "do not lose provider context",
    });

    const before = readConversation(owner, topic.title);
    const result = await compactTopicSession(topic.id, owner, "test-compact-failure", {
      summarize: async () => {
        throw new Error("summary unavailable");
      },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("summary unavailable");
    expect(getTopicSessionId(topic.id)).toBe(oldSessionId);
    expect(readConversation(owner, topic.title)).toEqual(before);

    await restartTopicSession(topic.id, owner, "test-compact-failure-cleanup", {
      archiveMemory: () => "below-threshold",
    });
  });
});
