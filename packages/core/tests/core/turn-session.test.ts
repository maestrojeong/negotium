import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearRoomQuery,
  getRoomQuery,
  type RoomQueryControl,
  setRoomQuery,
} from "#query/active-rooms";
import { AbortReason } from "#query/types";
import {
  mergeSupersedingUserTurn,
  renderUserPromptBatch,
  renderUserTurnBatch,
  resolveInitialTurnSessionId,
  resolveTopicTurnExecution,
  resolveTopicTurnSession,
  startAiTurn,
  triggerTopicAiTurn,
  userConversationPromptsToRecord,
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
  test("locally preserves three ordered user envelopes and duplicate attachments", () => {
    const second = mergeSupersedingUserTurn(
      {
        prompt: "first",
        userMessages: [{ prompt: "first", attachments: ["a", "shared", "shared"] }],
        sessionId: "base-session",
      },
      {
        prompt: "second",
        userMessages: [{ prompt: "second", attachments: ["shared", "b"] }],
      },
    );
    const third = mergeSupersedingUserTurn(second, {
      prompt: "third",
      userMessages: [{ prompt: "third", attachments: ["c", "shared"] }],
    });

    expect(third.userMessages).toEqual([
      { prompt: "first", attachments: ["a", "shared", "shared"] },
      { prompt: "second", attachments: ["shared", "b"] },
      { prompt: "third", attachments: ["c", "shared"] },
    ]);
    expect(third.prompt).toBe(renderUserPromptBatch(["first", "second", "third"]));
    expect(third.attachments).toEqual(["a", "shared", "shared", "shared", "b", "c", "shared"]);
    expect(third.sessionId).toBe("base-session");
  });

  test("leaves a single user prompt unchanged", () => {
    expect(renderUserPromptBatch(["hello"])).toBe("hello");
  });

  test("renders structured authors in an ordered steering batch", () => {
    expect(
      renderUserTurnBatch([
        { prompt: "first", actorUserId: "user-a", actorLabel: "Alice" },
        { prompt: "second", actorUserId: "user-b", actorLabel: "Bob" },
      ]),
    ).toBe(
      "[Consecutive user messages received before an assistant response]\n\n" +
        "1. [@Alice]: first\n" +
        "2. [@Bob]: second",
    );
  });

  test("keeps an actor label inside one author marker", () => {
    expect(
      renderUserTurnBatch([
        { prompt: "hello", actorUserId: "user-a", actorLabel: "Alice]\n[@Mallory" },
      ]),
    ).toBe("[@Alice) (@Mallory]: hello");
  });

  test("records only new envelopes while retaining their materialized attachment prompts", () => {
    expect(
      userConversationPromptsToRecord(
        [
          "first\n\n[Attached file: first.txt at path: /workspace/first.txt]",
          "second\n\n[Attached file: second.txt at path: /workspace/second.txt]",
        ],
        1,
        "batched provider prompt",
      ),
    ).toEqual(["second\n\n[Attached file: second.txt at path: /workspace/second.txt]"]);
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

  test("remotely preserves three envelopes and logs each user prompt once", () => {
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
      attachments: ["first.txt", "shared.txt", "shared.txt"],
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
      attachments: ["third.txt", "shared.txt"],
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
      userMessages: [
        { prompt: "queued user turn", attachments: ["first.txt", "shared.txt", "shared.txt"] },
        { prompt: "newer queued user turn", attachments: ["shared.txt", "second.txt"] },
        { prompt: "final queued user turn", attachments: ["third.txt", "shared.txt"] },
      ],
      attachments: [
        "first.txt",
        "shared.txt",
        "shared.txt",
        "shared.txt",
        "second.txt",
        "third.txt",
        "shared.txt",
      ],
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

  test("replays a session-only interrupted prompt with its steering message", () => {
    const topicId = seedTopic();
    const topic = getTopic(topicId)!;
    const running: RoomQueryControl = {
      topicId,
      queryId: `running-${randomUUID()}`,
      origin: "user",
      prompt: "already committed prompt",
      userMessages: [{ prompt: "already committed prompt" }],
      sessionId: "live-native-session",
      providerSessionObserved: true,
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    expect(setRoomQuery(running)).toBe(true);

    try {
      const replacementQueryId = startAiTurn({
        topic,
        userId: "owner",
        prompt: "steer the current work",
        allowAutoContinue: true,
      });

      expect(replacementQueryId).toBeString();
      expect(running.abortController.signal.aborted).toBe(true);
      expect(getRoomQuery(topicId)?.queryId).toBe(running.queryId);
      expect(getRuntimeUserTurnRequest(topicId)).toMatchObject({
        requestId: replacementQueryId,
        userMessages: [
          { prompt: "already committed prompt" },
          { prompt: "steer the current work" },
        ],
        execution: {
          sessionId: "live-native-session",
          sessionIdSpecified: true,
          conversationPrompts: ["steer the current work"],
          loggedUserMessageCount: 1,
        },
      });
    } finally {
      clearRoomQuery(topicId, running.queryId);
    }
  });

  test("omits an interrupted prompt only after provider content confirms it", () => {
    const topicId = seedTopic();
    const topic = getTopic(topicId)!;
    const running: RoomQueryControl = {
      topicId,
      queryId: `running-${randomUUID()}`,
      origin: "user",
      prompt: "already committed prompt",
      userMessages: [{ prompt: "already committed prompt" }],
      sessionId: "live-native-session",
      providerSessionObserved: true,
      providerTurnContentObserved: true,
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    expect(setRoomQuery(running)).toBe(true);

    try {
      const replacementQueryId = startAiTurn({
        topic,
        userId: "owner",
        prompt: "steer the current work",
        allowAutoContinue: true,
      });

      expect(getRuntimeUserTurnRequest(topicId)).toMatchObject({
        requestId: replacementQueryId,
        userMessages: [{ prompt: "steer the current work" }],
        execution: {
          sessionId: "live-native-session",
          sessionIdSpecified: true,
          conversationPrompts: ["steer the current work"],
        },
      });
    } finally {
      clearRoomQuery(topicId, running.queryId);
    }
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

describe("prompt cache stability", () => {
  // A provider's prefix cache invalidates from the first diverging byte, so any
  // per-turn text in the system prompt forces the whole prompt to be re-read on
  // every flip. Measured against the live DeepSeek API: one browser-availability
  // flip at turn 15 of a 20-turn conversation cost 17,852 uncached tokens
  // (hit=0) with the reminder in the system prompt, versus 1,215 with it on the
  // user turn — 40% more uncached tokens across the run.
  //
  // This is a source-level invariant because the placement lives inside the
  // turn generator, where the assembled strings are not observable from a unit
  // test. Same approach as tests/core/daemon-import-boundaries.test.ts.
  const source = readFileSync(resolve(import.meta.dir, "../../src/runtime/turn-runner.ts"), "utf8");

  test("per-turn reminders never enter the system prompt", () => {
    // Catches `systemPrompt +=`, `systemPrompt = \`${systemPrompt}...\``, and the
    // `effectiveSystemPrompt` variant this replaced.
    expect(source).not.toMatch(/systemPrompt\s*(?:\+=|=)[^;]*<system-reminder>/);
    expect(source).not.toMatch(/<system-reminder>[^`"]*`\s*;?\s*\n?\s*effectiveSystemPrompt/);
    expect(source).not.toContain("effectiveSystemPrompt");
  });

  test("per-turn reminders ride the user prompt tail", () => {
    expect(source).toContain("const turnReminders: string[] = []");
    expect(source).toContain("prompt: effectivePrompt,");
    // Every reminder *literal* in this file must be routed through the
    // collector. Matching on the opening quote skips prose mentions in comments.
    const reminders = source.match(/"<system-reminder>/g) ?? [];
    const pushes = source.match(/turnReminders\.push\(/g) ?? [];
    expect(reminders.length).toBeGreaterThan(0);
    expect(pushes.length).toBe(reminders.length);
  });

  test("a reminder is not recorded as part of the user message", () => {
    // The conversation log must hold `agentPrompt`, not the reminder-suffixed
    // `effectivePrompt` — otherwise the reminder persists into synthesized
    // rollouts and pollutes every later turn's history.
    const recordIndex = source.indexOf("userConversationPromptsToRecord(");
    const effectiveIndex = source.indexOf("const effectivePrompt =");
    expect(recordIndex).toBeGreaterThan(-1);
    expect(effectiveIndex).toBeGreaterThan(-1);
    expect(effectiveIndex).toBeGreaterThan(recordIndex);
  });
});
