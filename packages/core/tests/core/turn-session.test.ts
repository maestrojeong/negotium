import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
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
  completeRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";

const topicIds = new Set<string>();
const leases: Array<{ topicId: string; queryId: string; ownerId: string }> = [];

describe("default topic MCPs", () => {
  test("enables playwright for ordinary topics without duplicating it", () => {
    expect(withDefaultPlaywright([], false)).toEqual(["playwright"]);
    expect(withDefaultPlaywright(["background-bash"], false)).toEqual([
      "background-bash",
      "playwright",
    ]);
    expect(withDefaultPlaywright(["playwright"], false)).toEqual(["playwright"]);
  });

  test("keeps Manager free of playwright", () => {
    expect(withDefaultPlaywright(["background-bash"], true)).toEqual(["background-bash"]);
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
    const request = getRuntimeUserTurnRequest(id);
    if (request) completeRuntimeUserTurnRequest(id, request.requestId);
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
    let dispatchedQueryId: string | undefined;

    const queryId = triggerTopicAiTurn(topicId, "owner", "queued user turn", undefined, {
      origin: "user",
      onDispatched: (id) => {
        dispatchedQueryId = id;
      },
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
      allowAutoContinue: true,
    });
    expect(replacementQueryId).toBeString();
    if (!replacementQueryId) throw new Error("replacement turn did not reserve a query id");
    expect(replacementQueryId).not.toBe(queryId);
    expect(getRuntimeUserTurnRequest(topicId)?.requestId).toBe(replacementQueryId);
    const statuses = listRecentRuntimeEventsForTopic(topicId).map((event) => event.payload);
    expect(statuses).toContainEqual({ kind: "ai_active", queryId });
    expect(statuses).toContainEqual({ kind: "ai_aborted", queryId, reason: "superseded" });
    expect(statuses).toContainEqual({ kind: "ai_active", queryId: replacementQueryId });
  });
});
