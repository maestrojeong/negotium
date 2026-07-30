import { afterEach, describe, expect, test } from "bun:test";
import { db } from "#storage/forum-db";
import {
  claimRuntimeTurnLease,
  releaseRuntimeTurnLease,
  TURN_LEASE_STALE_MS,
} from "#storage/runtime-leases";
import {
  cancelRuntimeUserTurnRequests,
  claimNextRuntimeUserTurnRequest,
  completeRuntimeUserTurnRequest,
  enqueueRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
  markRuntimeUserTurnRunning,
} from "#storage/runtime-turn-requests";

const topics = new Set<string>();
const leases: Array<{ topicId: string; queryId: string; ownerId: string }> = [];

function topicId(): string {
  const id = `turn-request-${crypto.randomUUID()}`;
  topics.add(id);
  return id;
}

afterEach(() => {
  for (const topic of topics) {
    cancelRuntimeUserTurnRequests(topic);
  }
  for (const lease of leases) {
    releaseRuntimeTurnLease(lease.topicId, lease.queryId, lease.ownerId);
  }
  topics.clear();
  leases.length = 0;
});

describe("runtime user turn requests", () => {
  test("keeps only the newest user request for a busy topic", () => {
    const topic = topicId();
    const first = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "first",
      allowAutoContinue: true,
    });
    const second = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "second",
      userMessages: [
        { prompt: "first", attachments: ["/tmp/first.txt", "/tmp/first.txt"] },
        { prompt: "second", attachments: ["/tmp/example.txt"] },
      ],
      attachments: ["/tmp/first.txt", "/tmp/first.txt", "/tmp/example.txt"],
      allowAutoContinue: false,
      execution: {
        sourceRequestId: "host-request",
        agentOverride: "codex",
        modelOverride: "gpt-5.6-terra",
        sessionId: null,
        sessionIdSpecified: true,
        peerBridge: {
          hubCellId: "cell-a",
          hostTopicId: "host-topic",
          hostQueryId: "host-query",
          canSpawnSubagents: true,
        },
      },
    });

    expect(second).not.toBe(first);
    expect(getRuntimeUserTurnRequest(topic)).toMatchObject({
      requestId: second,
      prompt: "second",
      userMessages: [
        { prompt: "first", attachments: ["/tmp/first.txt", "/tmp/first.txt"] },
        { prompt: "second", attachments: ["/tmp/example.txt"] },
      ],
      attachments: ["/tmp/first.txt", "/tmp/first.txt", "/tmp/example.txt"],
      allowAutoContinue: false,
      execution: {
        sourceRequestId: "host-request",
        agentOverride: "codex",
        modelOverride: "gpt-5.6-terra",
        sessionId: null,
        sessionIdSpecified: true,
        peerBridge: {
          hubCellId: "cell-a",
          hostTopicId: "host-topic",
          hostQueryId: "host-query",
          canSpawnSubagents: true,
        },
      },
      status: "pending",
    });
  });

  test("migrates pending and running rows that predate prompt-batch and envelope columns", () => {
    const pendingTopic = topicId();
    const runningTopic = topicId();
    const runningRequestId = enqueueRuntimeUserTurnRequest({
      topicId: runningTopic,
      userId: "user",
      prompt: "legacy running",
      attachments: ["running-a", "running-b"],
      allowAutoContinue: true,
    });
    const running = claimNextRuntimeUserTurnRequest("legacy-worker");
    expect(running?.requestId).toBe(runningRequestId);
    expect(
      markRuntimeUserTurnRunning(runningTopic, runningRequestId, "legacy-worker", "legacy-query"),
    ).toBe(true);
    const pendingRequestId = enqueueRuntimeUserTurnRequest({
      topicId: pendingTopic,
      userId: "user",
      prompt: "legacy pending",
      attachments: ["pending-a", "pending-a"],
      allowAutoContinue: true,
    });
    db.query(
      `UPDATE runtime_user_turn_requests
       SET user_messages_json = NULL
       WHERE request_id IN (?, ?)`,
    ).run(pendingRequestId, runningRequestId);

    expect(getRuntimeUserTurnRequest(pendingTopic)?.userMessages).toEqual([
      { prompt: "legacy pending", attachments: ["pending-a", "pending-a"] },
    ]);
    expect(getRuntimeUserTurnRequest(runningTopic)).toMatchObject({
      status: "running",
      runningQueryId: "legacy-query",
      userMessages: [{ prompt: "legacy running", attachments: ["running-a", "running-b"] }],
    });
  });

  test("allows only one worker to claim a pending request", () => {
    const topic = topicId();
    enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "hello",
      allowAutoContinue: true,
    });

    expect(claimNextRuntimeUserTurnRequest("worker-a")?.topicId).toBe(topic);
    expect(claimNextRuntimeUserTurnRequest("worker-b")).toBeNull();
  });

  test("preserves gateway-style FIFO requests when superseding is disabled", () => {
    const topic = topicId();
    const first = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "first",
      allowAutoContinue: true,
      supersedeExisting: false,
    });
    const second = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "second",
      allowAutoContinue: true,
      supersedeExisting: false,
    });

    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(first);
    expect(claimNextRuntimeUserTurnRequest("competing-worker")).toBeNull();
    expect(completeRuntimeUserTurnRequest(topic, first, "worker")).toBe(true);
    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(second);
  });

  test("does not claim a request until the active topic lease is released", () => {
    const topic = topicId();
    const lease = { topicId: topic, queryId: "query", ownerId: "turn-owner" };
    leases.push(lease);
    expect(claimRuntimeTurnLease({ ...lease, origin: "user" })).toBe(true);
    enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "replace the running turn",
      allowAutoContinue: true,
    });

    expect(claimNextRuntimeUserTurnRequest("worker")).toBeNull();
    expect(releaseRuntimeTurnLease(topic, lease.queryId, lease.ownerId)).toBe(true);
    expect(claimNextRuntimeUserTurnRequest("worker")?.topicId).toBe(topic);
  });

  test("reclaims a running request after its worker becomes stale", () => {
    const topic = topicId();
    const requestId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "recover me",
      allowAutoContinue: true,
    });
    const claimed = claimNextRuntimeUserTurnRequest("dead-worker");
    expect(claimed?.requestId).toBe(requestId);
    expect(markRuntimeUserTurnRunning(topic, requestId, "dead-worker", "query-dead")).toBe(true);

    const future = Date.now() + TURN_LEASE_STALE_MS + 1;
    expect(claimNextRuntimeUserTurnRequest("replacement-worker", future)).toMatchObject({
      topicId: topic,
      requestId,
      status: "running",
      claimedBy: "replacement-worker",
      runningQueryId: "query-dead",
    });
    expect(completeRuntimeUserTurnRequest(topic, requestId, "dead-worker")).toBe(false);
    expect(getRuntimeUserTurnRequest(topic)?.claimedBy).toBe("replacement-worker");
    expect(completeRuntimeUserTurnRequest(topic, requestId, "replacement-worker")).toBe(true);
  });

  test("completion is guarded by the current request id and claim owner", () => {
    const topic = topicId();
    const oldRequest = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "old",
      allowAutoContinue: true,
    });
    const currentRequest = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "current",
      allowAutoContinue: true,
    });

    expect(completeRuntimeUserTurnRequest(topic, oldRequest, "worker")).toBe(false);
    expect(getRuntimeUserTurnRequest(topic)?.requestId).toBe(currentRequest);
    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(currentRequest);
    expect(completeRuntimeUserTurnRequest(topic, currentRequest, "other-worker")).toBe(false);
    expect(completeRuntimeUserTurnRequest(topic, currentRequest, "worker")).toBe(true);
  });
});
