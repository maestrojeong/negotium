import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  ensureRuntimeUserTurnRequestsSchema,
  getRuntimeUserTurnRequest,
  markRuntimeUserTurnMessagesLogged,
  markRuntimeUserTurnProviderSessionObserved,
  markRuntimeUserTurnRunning,
  mergeRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";
import type { StorageDatabase } from "#storage/storage-contract";
import { resetRuntimeTurnQueue } from "../fixtures/runtime-queue";

const topics = new Set<string>();
const leases: Array<{ topicId: string; queryId: string; ownerId: string }> = [];

function topicId(): string {
  const id = `turn-request-${crypto.randomUUID()}`;
  topics.add(id);
  return id;
}

beforeEach(resetRuntimeTurnQueue);

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

  test("upgrades a pre-envelope database while preserving pending and running rows", () => {
    const legacyDb = new Database(":memory:");
    try {
      legacyDb.exec(`
        CREATE TABLE runtime_user_turn_requests (
          request_id TEXT PRIMARY KEY,
          topic_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          attachments_json TEXT,
          allow_auto_continue INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          claimed_by TEXT,
          claimed_at INTEGER,
          running_query_id TEXT
        );
        INSERT INTO runtime_user_turn_requests VALUES
          ('pending-request', 'pending-topic', 'user', 'legacy pending',
           '["pending-a","pending-a"]', 1, 1, 'pending', NULL, NULL, NULL),
          ('running-request', 'running-topic', 'user', 'legacy running',
           '["running-a","running-b"]', 1, 2, 'running',
           'legacy-worker', 3, 'legacy-query');
      `);

      ensureRuntimeUserTurnRequestsSchema(legacyDb as unknown as StorageDatabase);

      const columns = legacyDb
        .query<{ name: string }, []>("PRAGMA table_info(runtime_user_turn_requests)")
        .all()
        .map((column) => column.name);
      expect(columns).toContain("execution_json");
      expect(columns).toContain("user_messages_json");
      expect(columns).toContain("topic_epoch");
      expect(
        legacyDb
          .query<{ request_id: string; status: string; running_query_id: string | null }, []>(
            `SELECT request_id, status, running_query_id
             FROM runtime_user_turn_requests ORDER BY created_at`,
          )
          .all(),
      ).toEqual([
        { request_id: "pending-request", status: "pending", running_query_id: null },
        {
          request_id: "running-request",
          status: "running",
          running_query_id: "legacy-query",
        },
      ]);
    } finally {
      legacyDb.close();
    }
  });

  test("falls back for rows that predate prompt-batch and envelope metadata", () => {
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

  test("atomically folds running, pending, and incoming messages into one replacement", () => {
    const topic = topicId();
    const runningId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "running",
      userMessages: [{ prompt: "running", attachments: ["running-file"] }],
      attachments: ["running-file"],
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: {
        sessionId: null,
        sessionIdSpecified: true,
        conversationPrompts: ["running"],
        loggedUserMessageCount: 0,
      },
    });
    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(runningId);
    expect(markRuntimeUserTurnRunning(topic, runningId, "worker", "running-query")).toBe(true);
    expect(
      markRuntimeUserTurnMessagesLogged(topic, runningId, "worker", [
        { prompt: "running", attachments: ["running-file"] },
      ]),
    ).toBe(true);
    enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "pending",
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: { conversationPrompts: ["pending"], loggedUserMessageCount: 0 },
    });

    const merged = mergeRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      userMessages: [{ prompt: "incoming", attachments: ["incoming-file"] }],
      allowAutoContinue: true,
      requestId: "replacement",
      execution: {
        sessionId: "partial-session",
        sessionIdSpecified: true,
        conversationPrompts: ["incoming"],
        loggedUserMessageCount: 0,
      },
      topicEpoch: 0,
    });

    expect(merged.supersededRequestIds).toHaveLength(2);
    expect(getRuntimeUserTurnRequest(topic)).toMatchObject({
      requestId: "replacement",
      userMessages: [
        { prompt: "running", attachments: ["running-file"] },
        { prompt: "pending" },
        { prompt: "incoming", attachments: ["incoming-file"] },
      ],
      attachments: ["running-file", "incoming-file"],
      execution: {
        sessionId: null,
        sessionIdSpecified: true,
        loggedUserMessageCount: 1,
        conversationPrompts: ["pending", "incoming"],
      },
    });
  });

  test("does not duplicate a durable prefix already merged in memory", () => {
    const topic = topicId();
    const runningId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "running",
      userMessages: [{ prompt: "running" }],
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: { conversationPrompts: ["running"], loggedUserMessageCount: 0 },
    });
    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(runningId);
    expect(
      markRuntimeUserTurnMessagesLogged(topic, runningId, "worker", [{ prompt: "running" }]),
    ).toBe(true);
    enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "pending between turns",
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: { conversationPrompts: ["pending between turns"], loggedUserMessageCount: 0 },
    });

    mergeRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      userMessages: [{ prompt: "running" }, { prompt: "running" }],
      allowAutoContinue: true,
      requestId: "replacement",
      execution: {
        conversationPrompts: ["running"],
        loggedUserMessageCount: 1,
      },
      topicEpoch: 0,
      alreadyIncludedRequestIds: [runningId],
    });

    expect(getRuntimeUserTurnRequest(topic)).toMatchObject({
      requestId: "replacement",
      userMessages: [
        { prompt: "running" },
        { prompt: "pending between turns" },
        { prompt: "running" },
      ],
      execution: {
        loggedUserMessageCount: 1,
        conversationPrompts: ["pending between turns", "running"],
      },
    });
  });

  test("omits a turn already committed to the provider session from its replacement prompt", () => {
    const topic = topicId();
    const committedId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "already in native rollout",
      userMessages: [{ prompt: "already in native rollout" }],
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: {
        sessionId: "native-session",
        sessionIdSpecified: true,
        conversationPrompts: [],
        loggedUserMessageCount: 1,
      },
    });
    enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "queued while stopping",
      userMessages: [{ prompt: "queued while stopping" }],
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: {
        sessionId: "native-session",
        sessionIdSpecified: true,
        conversationPrompts: ["queued while stopping"],
        loggedUserMessageCount: 0,
      },
    });

    const merged = mergeRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      userMessages: [{ prompt: "new steering message" }],
      allowAutoContinue: true,
      requestId: "replacement",
      execution: {
        sessionId: "native-session",
        sessionIdSpecified: true,
        conversationPrompts: ["new steering message"],
        loggedUserMessageCount: 0,
      },
      topicEpoch: 0,
      omitRequestIds: [committedId],
    });

    expect(merged.supersededRequestIds).toHaveLength(2);
    expect(getRuntimeUserTurnRequest(topic)).toMatchObject({
      requestId: "replacement",
      userMessages: [{ prompt: "queued while stopping" }, { prompt: "new steering message" }],
      execution: {
        sessionId: "native-session",
        sessionIdSpecified: true,
        loggedUserMessageCount: 0,
        conversationPrompts: ["queued while stopping", "new steering message"],
      },
    });
  });

  test("omits a provider-content-confirmed turn when another process merges its replacement", () => {
    const topic = topicId();
    const committedId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "already in remote native rollout",
      userMessages: [{ prompt: "already in remote native rollout" }],
      allowAutoContinue: true,
      execution: {
        sessionId: "base-session",
        sessionIdSpecified: true,
        conversationPrompts: [],
        loggedUserMessageCount: 1,
      },
    });
    expect(
      markRuntimeUserTurnProviderSessionObserved(topic, committedId, "live-native-session"),
    ).toBe(true);

    mergeRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      userMessages: [{ prompt: "remote steering message" }],
      allowAutoContinue: true,
      requestId: "replacement",
      execution: {
        sessionId: "live-native-session",
        sessionIdSpecified: true,
        conversationPrompts: ["remote steering message"],
        loggedUserMessageCount: 0,
      },
      topicEpoch: 0,
    });

    expect(getRuntimeUserTurnRequest(topic)).toMatchObject({
      requestId: "replacement",
      userMessages: [{ prompt: "remote steering message" }],
      execution: {
        sessionId: "live-native-session",
        conversationPrompts: ["remote steering message"],
      },
    });
    expect(getRuntimeUserTurnRequest(topic)?.execution?.providerSessionId).toBeUndefined();
    expect(markRuntimeUserTurnProviderSessionObserved(topic, committedId, "late-session")).toBe(
      false,
    );
  });

  test("carries an append acknowledgement onto a concurrent replacement", () => {
    const topic = topicId();
    const originalId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "original",
      userMessages: [{ prompt: "original", attachments: ["original-file"] }],
      attachments: ["original-file"],
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: { conversationPrompts: ["original"], loggedUserMessageCount: 0 },
    });
    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(originalId);

    mergeRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      userMessages: [{ prompt: "incoming" }],
      allowAutoContinue: true,
      requestId: "replacement",
      execution: { conversationPrompts: ["incoming"], loggedUserMessageCount: 0 },
      topicEpoch: 0,
    });
    mergeRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      userMessages: [{ prompt: "later" }],
      allowAutoContinue: true,
      requestId: "second-replacement",
      execution: { conversationPrompts: ["later"], loggedUserMessageCount: 0 },
      topicEpoch: 0,
    });

    expect(
      markRuntimeUserTurnMessagesLogged(topic, originalId, "worker", [
        { prompt: "original", attachments: ["original-file"] },
      ]),
    ).toBe(true);
    expect(getRuntimeUserTurnRequest(topic)).toMatchObject({
      requestId: "second-replacement",
      execution: {
        loggedUserMessageCount: 1,
        conversationPrompts: ["incoming", "later"],
      },
    });
  });

  test("does not carry a late acknowledgement onto an unrelated matching FIFO request", () => {
    const topic = topicId();
    const originalId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "same",
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: { conversationPrompts: ["same"], loggedUserMessageCount: 0 },
    });
    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(originalId);
    db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ?").run(topic);

    enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "same",
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: { conversationPrompts: ["same"], loggedUserMessageCount: 0 },
    });

    expect(
      markRuntimeUserTurnMessagesLogged(topic, originalId, "worker", [{ prompt: "same" }]),
    ).toBe(false);
    expect(getRuntimeUserTurnRequest(topic)?.execution).toMatchObject({
      loggedUserMessageCount: 0,
      conversationPrompts: ["same"],
    });
  });

  test("does not treat a claimed request with a stale lease as already logged", () => {
    const topic = topicId();
    const requestId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      prompt: "claimed but not dispatched",
      allowAutoContinue: true,
      supersedeExisting: false,
      execution: { conversationPrompts: ["claimed but not dispatched"], loggedUserMessageCount: 0 },
    });
    expect(claimNextRuntimeUserTurnRequest("worker")?.requestId).toBe(requestId);

    const lease = { topicId: topic, queryId: "query", ownerId: "turn-owner" };
    leases.push(lease);
    expect(claimRuntimeTurnLease({ ...lease, origin: "user" })).toBe(true);
    db.query("UPDATE runtime_turn_leases SET heartbeat_at = ? WHERE topic_id = ?").run(
      Date.now() - TURN_LEASE_STALE_MS - 1,
      topic,
    );

    mergeRuntimeUserTurnRequest({
      topicId: topic,
      userId: "user",
      userMessages: [{ prompt: "incoming" }],
      allowAutoContinue: true,
      requestId: "replacement",
      execution: { conversationPrompts: ["incoming"], loggedUserMessageCount: 0 },
      topicEpoch: 0,
    });

    expect(getRuntimeUserTurnRequest(topic)?.execution).toMatchObject({
      loggedUserMessageCount: 0,
      conversationPrompts: ["claimed but not dispatched", "incoming"],
    });
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
