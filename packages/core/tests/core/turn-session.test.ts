import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mergeSupersedingUserTurn,
  renderUserPromptBatch,
  resolveInitialTurnSessionId,
  resolveTopicTurnExecution,
  resolveTopicTurnSession,
  startAiTurn,
  triggerTopicAiTurn,
  withDefaultPlaywright,
} from "#runtime/turn-runner";
import { getAllMessagesForTopic } from "#storage/api-messages";
import { setApiTopicConfig } from "#storage/api-topic-config";
import { deleteTopic, getTopic, setTopicSessionId, upsertTopic } from "#storage/api-topics";
import { listRecentRuntimeEventsForTopic } from "#storage/runtime-events";
import { claimRuntimeTurnLease, releaseRuntimeTurnLease } from "#storage/runtime-leases";
import {
  cancelRuntimeUserTurnRequests,
  getRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";

const topicIds = new Set<string>();
const leases: Array<{ topicId: string; queryId: string; ownerId: string }> = [];

describe("default topic MCPs", () => {
  test("enables browser and background shell tools for ordinary topics without duplicates", () => {
    expect(withDefaultPlaywright([], false)).toEqual(["playwright", "background-bash"]);
    expect(withDefaultPlaywright(["background-bash"], false)).toEqual([
      "background-bash",
      "playwright",
    ]);
    expect(withDefaultPlaywright(["playwright"], false)).toEqual(["playwright", "background-bash"]);
  });

  test("does not add browser or background shell tools to Manager", () => {
    expect(withDefaultPlaywright([], true)).toEqual([]);
  });
});

describe("superseding user turns", () => {
  test("preserves ordered prompts, attachments, and the pre-turn provider session", () => {
    const second = mergeSupersedingUserTurn(
      {
        prompt: "first",
        userPrompts: ["first"],
        attachments: ["a", "shared"],
        sessionId: "base-session",
      },
      {
        prompt: "second",
        userPrompts: ["second"],
        attachments: ["shared", "b"],
      },
    );
    const third = mergeSupersedingUserTurn(second, {
      prompt: "third",
      userPrompts: ["third"],
    });

    expect(third.userPrompts).toEqual(["first", "second", "third"]);
    expect(third.prompt).toBe(renderUserPromptBatch(["first", "second", "third"]));
    expect(third.attachments).toEqual(["a", "shared", "b"]);
    expect(third.sessionId).toBe("base-session");
  });

  test("leaves a single user prompt unchanged", () => {
    expect(renderUserPromptBatch(["hello"])).toBe("hello");
  });
});

function seedTopic(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `turn-session-${id}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    participants: [{ userId: "owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  topicIds.add(id);
  return id;
}

afterEach(() => {
  for (const id of topicIds) {
    cancelRuntimeUserTurnRequests(id);
    deleteTopic(id);
  }
  for (const lease of leases) releaseRuntimeTurnLease(lease.topicId, lease.queryId, lease.ownerId);
  topicIds.clear();
  leases.length = 0;
});

describe("turn session resolution", () => {
  test("direct turns resume the durable topic session", () => {
    const topicId = seedTopic();
    setTopicSessionId(topicId, "persisted-session", { reason: "test", agent: "codex" });

    expect(resolveInitialTurnSessionId(topicId, undefined, false)).toBe("persisted-session");
  });

  test("explicit fresh starts and isolated turns do not borrow the topic session", () => {
    const topicId = seedTopic();
    setTopicSessionId(topicId, "persisted-session", { reason: "test", agent: "codex" });

    expect(resolveInitialTurnSessionId(topicId, null, false)).toBeNull();
    expect(resolveInitialTurnSessionId(topicId, undefined, true)).toBeUndefined();
  });

  test("execution overrides and alternate namespaces cannot borrow the main provider session", () => {
    const topicId = seedTopic();
    const topic = getTopic(topicId)!;
    setTopicSessionId(topicId, "persisted-session", { reason: "test", agent: "codex" });

    expect(resolveTopicTurnSession(topic, undefined)).toEqual({
      sessionId: "persisted-session",
      isolated: false,
    });
    expect(resolveTopicTurnSession(topic, undefined, { modelOverride: "gpt-5.6-terra" })).toEqual({
      sessionId: undefined,
      isolated: true,
    });
    expect(resolveTopicTurnSession(topic, undefined, { agentOverride: "maestro" })).toEqual({
      sessionId: undefined,
      isolated: true,
    });
    expect(resolveTopicTurnSession(topic, undefined, { sessionName: "cron-topic" })).toEqual({
      sessionId: undefined,
      isolated: true,
    });
  });

  test("execution metadata uses the same normalized model as the provider", () => {
    const topicId = seedTopic();
    const topic = getTopic(topicId)!;
    setApiTopicConfig(topicId, { model: "gpt-5.6-terra", effort: "high" });

    expect(resolveTopicTurnExecution(topic)).toEqual({
      agent: "codex",
      model: "gpt-5.6-terra",
      effort: "high",
    });
    expect(resolveTopicTurnExecution(topic, { agentOverride: "maestro" })).toEqual({
      agent: "maestro",
      model: "deepseek-pro",
      effort: "medium",
    });
  });

  test("a stale caller DTO cannot resurrect a deleted topic", () => {
    const topicId = seedTopic();
    const topic = getTopic(topicId)!;
    deleteTopic(topicId);
    let settlement: { kind: string; error?: string } | undefined;

    expect(
      startAiTurn({
        topic,
        userId: "owner",
        prompt: "must not run",
        allowAutoContinue: true,
        onSettled: (result) => {
          settlement = result;
        },
      }),
    ).toBeNull();
    expect(settlement).toMatchObject({ kind: "error", error: "topic no longer exists" });
  });

  test("cross-process handoff keeps one stable query id for the originating adapter", () => {
    const topicId = seedTopic();
    const topic = getTopic(topicId)!;
    const lease = {
      topicId,
      queryId: `remote-${randomUUID()}`,
      ownerId: `owner-${randomUUID()}`,
    };
    leases.push(lease);
    expect(claimRuntimeTurnLease({ ...lease, origin: "user" })).toBe(true);
    setApiTopicConfig(topicId, { model: "gpt-5.6-terra" });
    setTopicSessionId(topicId, "pre-turn-session", { reason: "test", agent: "codex" });
    let dispatchedQueryId: string | undefined;

    const queryId = triggerTopicAiTurn(topicId, "owner", "queued user turn", undefined, {
      origin: "user",
      onDispatched: (id) => {
        dispatchedQueryId = id;
      },
      attachments: ["first.txt", "shared.txt"],
      peerBridge: {
        hubCellId: "cell-a",
        hostTopicId: "host-topic",
        hostQueryId: "host-query",
        canSpawnSubagents: true,
      },
    });

    expect(queryId).toBeString();
    if (!queryId) throw new Error("queued turn did not reserve a query id");
    expect(dispatchedQueryId).toBe(queryId);
    setTopicSessionId(topicId, "partial-interrupted-session", {
      reason: "test",
      agent: "codex",
    });
    expect(getAllMessagesForTopic(topicId).at(-1)).toMatchObject({
      text: "queued user turn",
      agent_type: "codex",
      model: "gpt-5.6-terra",
    });
    expect(getRuntimeUserTurnRequest(topicId)).toMatchObject({
      requestId: queryId,
      execution: {
        peerBridge: {
          hubCellId: "cell-a",
          hostTopicId: "host-topic",
          hostQueryId: "host-query",
          canSpawnSubagents: true,
        },
      },
    });

    const replacementQueryId = startAiTurn({
      topic,
      userId: "owner",
      prompt: "newer queued user turn",
      attachments: ["shared.txt", "second.txt"],
      allowAutoContinue: true,
    });
    expect(replacementQueryId).toBeString();
    if (!replacementQueryId) throw new Error("replacement turn did not reserve a query id");
    expect(replacementQueryId).not.toBe(queryId);
    const finalQueryId = startAiTurn({
      topic,
      userId: "owner",
      prompt: "final queued user turn",
      attachments: ["third.txt"],
      allowAutoContinue: true,
    });
    expect(finalQueryId).toBeString();
    if (!finalQueryId) throw new Error("final turn did not reserve a query id");
    expect(getRuntimeUserTurnRequest(topicId)?.requestId).toBe(finalQueryId);
    expect(getRuntimeUserTurnRequest(topicId)).toMatchObject({
      prompt: renderUserPromptBatch([
        "queued user turn",
        "newer queued user turn",
        "final queued user turn",
      ]),
      userPrompts: ["queued user turn", "newer queued user turn", "final queued user turn"],
      attachments: ["first.txt", "shared.txt", "second.txt", "third.txt"],
      execution: {
        sessionId: "pre-turn-session",
        sessionIdSpecified: true,
        conversationPrompts: [
          "queued user turn",
          "newer queued user turn",
          "final queued user turn",
        ],
      },
    });
    const statuses = listRecentRuntimeEventsForTopic(topicId).map((event) => event.payload);
    expect(statuses).toContainEqual({ kind: "ai_active", queryId });
    expect(statuses).toContainEqual({ kind: "ai_aborted", queryId, reason: "superseded" });
    expect(statuses).toContainEqual({ kind: "ai_active", queryId: replacementQueryId });
  });

  test("provider failures terminate the dispatched turn with ai_error only", async () => {
    const topicId = seedTopic();
    const topic = getTopic(topicId)!;
    let settle: ((result: { kind: string; error?: string }) => void) | undefined;
    const settled = new Promise<{ kind: string; error?: string }>((resolve) => {
      settle = resolve;
    });

    const queryId = startAiTurn({
      topic,
      userId: "owner",
      prompt: "fail before provider dispatch",
      allowAutoContinue: true,
      prepareSession: async () => {
        throw new Error("provider unavailable");
      },
      onSettled: (result) => settle?.(result),
    });

    expect(queryId).toBeString();
    if (!queryId) throw new Error("turn did not dispatch");
    expect(await settled).toMatchObject({
      kind: "error",
      error: "failed to prepare isolated session: provider unavailable",
    });

    const statuses = listRecentRuntimeEventsForTopic(topicId)
      .map((event) => event.payload)
      .filter(
        (payload): payload is { kind: string; queryId: string; error?: string } =>
          typeof payload === "object" &&
          payload !== null &&
          "queryId" in payload &&
          payload.queryId === queryId,
      );
    expect(statuses).toContainEqual({ kind: "ai_active", queryId });
    expect(statuses).toContainEqual({
      kind: "ai_error",
      queryId,
      error: "failed to prepare isolated session: provider unavailable",
    });
    expect(statuses.some((status) => status.kind === "ai_done")).toBe(false);
  });
});
