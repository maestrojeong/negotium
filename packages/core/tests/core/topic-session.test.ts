import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { nextUsageAlert } from "#runtime/usage-alert";
import { appendApiMessage, getAllMessagesForTopic } from "#storage/api-messages";
import {
  deleteTopic,
  getTopic,
  getTopicSessionId,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import {
  appendConversationEventStrict,
  readConversation,
  readRawConversation,
  replaceConversationStrict,
} from "#storage/conversations";
import { db } from "#storage/forum-db";
import { claimRuntimeTurnLease, releaseRuntimeTurnLease } from "#storage/runtime-leases";
import {
  enqueueRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";
import { registerTopic } from "#topics/create";
import {
  compactTopicSession,
  createCompactedRolloutEntries,
  restartTopicSession,
  shouldCompactForkEntries,
  shouldUseCompactionLog,
  splitCompactionPairs,
} from "#topics/session";

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
  test("waits for memory archiving before purging provider context", async () => {
    const { owner, topic } = createTopic();
    const sessionId = "01940000-0000-7000-8000-000000000099";
    setTopicSessionId(topic.id, sessionId, { reason: "test", agent: "codex" });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "remember before reset",
    });
    let archived = false;
    let settleArchive: (() => void) | undefined;

    const resultPromise = restartTopicSession(topic.id, owner, "test-reset", {
      archiveMemory: (topicId, userId, options) => {
        expect(topicId).toBe(topic.id);
        expect(userId).toBe(owner);
        expect(options).toMatchObject({
          reason: "reset",
          minMessages: 1,
          minExchanges: 6,
          allowMentionOnly: true,
          skipBusyCheck: true,
        });
        expect(getTopicSessionId(topic.id)).toBe(sessionId);
        expect(readConversation(owner, topic.title)).toHaveLength(1);
        archived = true;
        settleArchive = () => options.onSettled?.(true);
        return "archived";
      },
      purgeLogs: async () => {
        expect(archived).toBe(true);
        replaceConversationStrict(owner, topic.title, []);
        return true;
      },
    });

    await Promise.resolve();
    expect(archived).toBe(true);
    expect(readConversation(owner, topic.title)).toHaveLength(1);
    settleArchive?.();
    const result = await resultPromise;

    expect(result.isError).toBeUndefined();
    expect(archived).toBe(true);
    expect(readConversation(owner, topic.title)).toEqual([]);
  });

  test("times out a stuck memory archiver without clearing provider context", async () => {
    const { owner, topic } = createTopic();
    setTopicSessionId(topic.id, "stuck-memory-session", { reason: "test", agent: "codex" });
    let purged = false;

    const result = await restartTopicSession(topic.id, owner, "test-reset", {
      archiveMemory: () => "archived",
      memoryArchiveWaitMs: 5,
      purgeLogs: async () => {
        purged = true;
        return true;
      },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("did not finish in time");
    expect(purged).toBe(false);
    expect(getTopicSessionId(topic.id)).toBe("stuck-memory-session");
  });

  test("does not purge after losing maintenance ownership during memory archiving", async () => {
    const { owner, topic } = createTopic();
    setTopicSessionId(topic.id, "ownership-session", { reason: "test", agent: "codex" });
    let finishArchive: (() => void) | undefined;
    let purged = false;

    try {
      const resultPromise = restartTopicSession(topic.id, owner, "test-reset", {
        archiveMemory: (_topicId, _userId, options) => {
          finishArchive = () => options.onSettled?.(true);
          return "archived";
        },
        purgeLogs: async () => {
          purged = true;
          return true;
        },
      });

      await Promise.resolve();
      db.query("UPDATE runtime_topic_state SET maintenance_owner = ? WHERE topic_id = ?").run(
        "replacement-owner",
        topic.id,
      );
      finishArchive?.();
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(result.text).toContain("ownership was lost");
      expect(purged).toBe(false);
      expect(getTopicSessionId(topic.id)).toBe("ownership-session");
    } finally {
      db.query("DELETE FROM runtime_topic_state WHERE topic_id = ?").run(topic.id);
    }
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

    const result = await restartTopicSession(topic.id, owner, "test-reset", {
      purgeLogs: async () => true,
    });

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

  test("keeps the current session when provider context cleanup fails", async () => {
    const { owner, topic } = createTopic();
    setTopicSessionId(topic.id, "cleanup-failed-session", {
      reason: "test",
      agent: "codex",
    });

    const result = await restartTopicSession(topic.id, owner, "test-reset", {
      archiveMemory: () => "empty",
      purgeLogs: async () => false,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("could not remove all provider context");
    expect(getTopicSessionId(topic.id)).toBe("cleanup-failed-session");
  });

  test("purges every participant context before committing a reset", async () => {
    const { owner, topic } = createTopic();
    const member = `member-${randomUUID()}`;
    topic.participants.push({ userId: member, role: "member" });
    upsertTopic(topic);
    setTopicSessionId(topic.id, "multi-user-session", {
      reason: "test",
      agent: "codex",
    });
    const purgedUsers: string[] = [];

    const result = await restartTopicSession(topic.id, owner, "test-reset", {
      archiveMemory: () => "empty",
      purgeLogs: async (options) => {
        purgedUsers.push(String(options.userId));
        return true;
      },
    });

    expect(result.isError).toBeUndefined();
    expect(purgedUsers).toEqual([owner, member]);
    expect(getTopicSessionId(topic.id)).toBeNull();
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
      const result = await restartTopicSession(topic.id, owner, undefined, {
        purgeLogs: async () => true,
      });

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
    upsertTopic(topic);
    setTopicSessionId(topic.id, "personal-general-session", {
      reason: "test",
      agent: "codex",
    });

    const result = await restartTopicSession(topic.id, owner, undefined, {
      purgeLogs: async () => true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.text).toBe('Session reset for "General". The next message starts fresh.');
    expect(getTopicSessionId(topic.id)).toBeNull();
  });
});

describe("compactTopicSession", () => {
  function koreanEntries(chars: number) {
    return [
      {
        ts: new Date().toISOString(),
        agent: "codex" as const,
        event: { type: "user_message" as const, content: "가".repeat(chars) },
      },
      {
        ts: new Date().toISOString(),
        agent: "codex" as const,
        event: { type: "result" as const, content: "확인", stopReason: "end_turn" },
      },
    ];
  }

  test("charges CJK text conservatively for automatic fork compaction", () => {
    // maestro-agent-sdk 0.1.53 estimates ~1.12 tokens per CJK character, so
    // 30k characters clears the 28k threshold.
    expect(shouldCompactForkEntries(koreanEntries(30_000))).toBe(true);
  });

  test("does not over-charge CJK into premature compaction", () => {
    // The counterpart the old test lacked. `shouldCompactForkEntries` used to
    // add its own `chars * (1 - 1/3.5)` surcharge on top of what became a
    // script-aware estimator, reaching ~1.83 tokens/char. At that rate 20k
    // Korean characters scored ~36.6k and tripped the 28k threshold even
    // though the real cost is ~22.3k — Korean topics compacted far too early.
    expect(shouldCompactForkEntries(koreanEntries(20_000))).toBe(false);
  });

  test("keeps a token-bounded recent tail out of the summary prefix", async () => {
    const { owner, topic } = createTopic();
    const entries = Array.from({ length: 4 }, (_, index) => [
      {
        ts: new Date().toISOString(),
        agent: "codex" as const,
        event: {
          type: "user_message" as const,
          content: `user-${index}-${"u".repeat(40_000)}`,
        },
      },
      {
        ts: new Date().toISOString(),
        agent: "codex" as const,
        event: {
          type: "result" as const,
          content: `assistant-${index}-${"a".repeat(40_000)}`,
          stopReason: "end_turn",
        },
      },
    ]).flat();
    const split = splitCompactionPairs(entries, 64_000);
    expect(split.summaryPairs.length).toBeGreaterThan(0);
    expect(split.retainedPairs.length).toBeGreaterThan(0);

    let source = "";
    const compacted = await createCompactedRolloutEntries(
      {
        topicId: topic.id,
        topicTitle: topic.title,
        userId: owner,
        entries,
        visibleMessages: [],
        retainedTailTokens: 64_000,
        agent: "codex",
        model: "gpt-5.6-luna",
        cwd: "/tmp",
      },
      async (request) => {
        source = request.source;
        return "summary";
      },
    );

    expect(source).toContain("user-0-");
    expect(source).not.toContain("user-3-");
    expect(
      compacted.some(
        (entry) => entry.event.type === "user_message" && entry.event.content.includes("user-3-"),
      ),
    ).toBe(true);
  });

  test("aborts a compactor that exceeds its deadline", async () => {
    const { owner, topic } = createTopic();
    let signal: AbortSignal | undefined;

    await expect(
      createCompactedRolloutEntries(
        {
          topicId: topic.id,
          topicTitle: topic.title,
          userId: owner,
          entries: [
            {
              ts: new Date().toISOString(),
              agent: "codex",
              event: { type: "user_message", content: "context to compact" },
            },
            {
              ts: new Date().toISOString(),
              agent: "codex",
              event: { type: "result", content: "working state", stopReason: "end_turn" },
            },
          ],
          agent: "codex",
          model: "gpt-5.6-luna",
          cwd: "/tmp",
          timeoutMs: 5,
        },
        async (request) => {
          signal = request.signal;
          await new Promise<void>(() => {});
          return "unreachable";
        },
      ),
    ).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });

  test("keeps both ends of an oversized provider message in the summary source", async () => {
    const { owner, topic } = createTopic();
    let source = "";
    const entries = await createCompactedRolloutEntries(
      {
        topicId: topic.id,
        topicTitle: topic.title,
        userId: owner,
        entries: [
          {
            ts: new Date().toISOString(),
            agent: "codex",
            event: {
              type: "user_message",
              content: `request-start ${"x".repeat(100_000)} request-end`,
            },
          },
          {
            ts: new Date().toISOString(),
            agent: "codex",
            event: { type: "result", content: "response-end", stopReason: "end_turn" },
          },
        ],
        agent: "codex",
        model: "gpt-5.6-luna",
        cwd: "/tmp",
      },
      async (request) => {
        source = request.source;
        return "summary";
      },
    );

    expect(source).toContain("request-start");
    expect(source).toContain("request-end");
    expect(source).toContain("response-end");
    expect(entries[1]?.event).toMatchObject({ type: "result", content: "summary" });
  });

  test("routes only long compaction sources through the scoped log reader", async () => {
    const { owner, topic } = createTopic();
    let source = "";
    await createCompactedRolloutEntries(
      {
        topicId: topic.id,
        topicTitle: topic.title,
        userId: owner,
        entries: [
          {
            ts: new Date().toISOString(),
            agent: "codex",
            event: { type: "user_message", content: `start ${"x".repeat(150_000)} end` },
          },
          {
            ts: new Date().toISOString(),
            agent: "codex",
            event: { type: "result", content: "latest state", stopReason: "end_turn" },
          },
        ],
        agent: "codex",
        model: "gpt-5.6-luna",
        cwd: "/tmp",
      },
      async (request) => {
        source = request.source;
        return "summary";
      },
    );

    expect(source.length).toBeGreaterThan(100_000);
    expect(shouldUseCompactionLog(source)).toBe(true);
    expect(shouldUseCompactionLog("short context")).toBe(false);
  });

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
    const rawBeforeCompact = readRawConversation(owner, topic.title);

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
    const rawAfterCompact = readRawConversation(owner, topic.title);
    expect(rawAfterCompact.slice(0, rawBeforeCompact.length)).toEqual(rawBeforeCompact);
    expect(rawAfterCompact.at(-1)?.event).toMatchObject({
      type: "session",
      sessionId: getTopicSessionId(topic.id),
    });

    await restartTopicSession(topic.id, owner, "test-compact-cleanup", {
      archiveMemory: () => "below-threshold",
    });
  });

  test("non-preemptive compact bails without touching a locally running turn", async () => {
    const { owner, topic } = createTopic();
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "context to compact",
    });
    const queryId = randomUUID();
    claimRuntimeTurnLease({ topicId: topic.id, queryId, origin: "test" });
    const summarize = mock(async () => "should never run");
    try {
      const result = await compactTopicSession(topic.id, owner, "test-idle-compact-busy", {
        summarize,
        preemptive: false,
      });

      expect(result).toMatchObject({ isError: true, busy: true });
      expect(summarize).not.toHaveBeenCalled();
      // The turn lease must still be intact — non-preemptive compact never
      // aborts or cancels work already in flight.
      expect(getRuntimeUserTurnRequest(topic.id)).toBeNull();
    } finally {
      releaseRuntimeTurnLease(topic.id, queryId);
    }
  });

  test("non-preemptive compact bails on a queued turn request even with no active lease", async () => {
    const { owner, topic } = createTopic();
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "context to compact",
    });
    enqueueRuntimeUserTurnRequest({
      topicId: topic.id,
      userId: owner,
      prompt: "queued follow-up",
      allowAutoContinue: false,
    });
    const summarize = mock(async () => "should never run");

    const result = await compactTopicSession(topic.id, owner, "test-idle-compact-queued", {
      summarize,
      preemptive: false,
    });

    expect(result).toMatchObject({ isError: true, busy: true });
    expect(summarize).not.toHaveBeenCalled();
    expect(getRuntimeUserTurnRequest(topic.id)).not.toBeNull();
  });

  test("non-preemptive compact proceeds once the topic is truly idle", async () => {
    const { owner, topic } = createTopic();
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "context to compact",
    });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "result",
      content: "provider response to preserve",
      stopReason: "end_turn",
    });

    const result = await compactTopicSession(topic.id, owner, "test-idle-compact-quiet", {
      summarize: async () => "idle compact summary",
      preemptive: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.busy).toBeUndefined();
  });

  test("keeps a committed compact session when old rollout cleanup is deferred", async () => {
    const { owner, topic } = createTopic();
    const oldSessionId = "01940000-0000-7000-8000-000000000003";
    setTopicSessionId(topic.id, oldSessionId, { reason: "test", agent: "codex" });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "user_message",
      content: "context to compact",
    });
    appendConversationEventStrict(owner, topic.title, "codex", {
      type: "result",
      content: "provider response to preserve",
      stopReason: "end_turn",
    });
    const cleanupOldRollouts = mock(async () => false);

    const result = await compactTopicSession(topic.id, owner, "test-compact-deferred-cleanup", {
      summarize: async () => "committed summary",
      cleanupOldRollouts,
    });

    expect(result.isError).toBeUndefined();
    expect(cleanupOldRollouts).toHaveBeenCalledTimes(1);
    expect(getTopicSessionId(topic.id)).not.toBe(oldSessionId);
    expect(readConversation(owner, topic.title)[1]?.event).toMatchObject({
      type: "result",
      content: "committed summary",
    });
    const deferredManifest = readConversation(owner, topic.title);
    expect(
      deferredManifest.some(
        (entry) => entry.event.type === "session" && entry.event.sessionId === oldSessionId,
      ),
    ).toBe(true);
    expect(deferredManifest.at(-1)?.event).toMatchObject({
      type: "session",
      sessionId: getTopicSessionId(topic.id),
    });

    await restartTopicSession(topic.id, owner, "test-compact-deferred-cleanup-reset", {
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
