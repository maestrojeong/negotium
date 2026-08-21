import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";
import {
  claimSessionInboxBatch,
  completeSessionInboxBatch,
  enqueueSessionInbox,
  listPendingSessionInboxTopics,
  recoverSessionInboxClaims,
  releaseSessionInboxBatch,
} from "#storage/session-inbox";

const topicIds = new Set<string>();

function topicId(): string {
  const id = `session-inbox-test-${randomUUID()}`;
  topicIds.add(id);
  return id;
}

afterEach(() => {
  for (const id of topicIds) db.run("DELETE FROM session_inbox WHERE topic_id = ?", [id]);
  topicIds.clear();
});

describe("SQLite session inbox", () => {
  test("enqueues, claims, and completes one durable delivery", () => {
    const topic = topicId();
    expect(
      enqueueSessionInbox({
        id: `queue-${randomUUID()}`,
        userId: "user-1",
        topicId: topic,
        entry: { type: "tell", requestId: "request-1", message: "hello" },
      }).inserted,
    ).toBe(true);

    expect(listPendingSessionInboxTopics()).toContainEqual({ userId: "user-1", topicId: topic });
    const claimed = claimSessionInboxBatch({
      userId: "user-1",
      topicId: topic,
      ownerId: "worker-1",
    });
    expect(claimed).toHaveLength(1);
    expect(JSON.parse(claimed[0]!.payload)).toMatchObject({ requestId: "request-1" });
    expect(completeSessionInboxBatch([claimed[0]!.id], "worker-1")).toBe(1);
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM session_inbox WHERE topic_id = ?",
        )
        .get(topic)?.count,
    ).toBe(0);
  });

  test("an interrupted claim is recoverable exactly once", () => {
    const topic = topicId();
    const queueId = `queue-${randomUUID()}`;
    enqueueSessionInbox({
      id: queueId,
      userId: "user-2",
      topicId: topic,
      entry: { type: "tell", requestId: "request-crash", message: "retry me" },
    });
    expect(
      claimSessionInboxBatch({ userId: "user-2", topicId: topic, ownerId: "dead-worker" }),
    ).toHaveLength(1);
    expect(recoverSessionInboxClaims()).toBeGreaterThanOrEqual(1);
    const retried = claimSessionInboxBatch({
      userId: "user-2",
      topicId: topic,
      ownerId: "replacement-worker",
    });
    expect(retried.map((row) => row.id)).toEqual([queueId]);
    expect(completeSessionInboxBatch([queueId], "replacement-worker")).toBe(1);
    expect(releaseSessionInboxBatch([queueId], "dead-worker")).toBe(0);
  });

  test("different request ids retain independent FIFO claims", () => {
    const topic = topicId();
    const ids = [`queue-${randomUUID()}`, `queue-${randomUUID()}`];
    for (const [index, id] of ids.entries()) {
      enqueueSessionInbox({
        id,
        userId: "user-3",
        topicId: topic,
        entry: { type: "tell", requestId: `request-${index}`, message: String(index) },
      });
    }
    const claimed = claimSessionInboxBatch({
      userId: "user-3",
      topicId: topic,
      ownerId: "worker-concurrent",
    });
    expect(claimed.map((row) => row.id)).toEqual(ids);
  });
});
