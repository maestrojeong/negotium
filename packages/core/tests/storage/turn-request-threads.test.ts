import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { renderUserTurnBatch } from "#runtime/user-turn-envelope";
import { db } from "#storage/forum-db";
import {
  getRuntimeUserTurnRequest,
  mergeRuntimeUserTurnRequest,
  type RuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";

const topics: string[] = [];

function submit(topicId: string, prompt: string, threadRootId?: string) {
  return mergeRuntimeUserTurnRequest({
    topicId,
    userId: "local",
    userMessages: [{ prompt }],
    allowAutoContinue: true,
    requestId: `req-${randomUUID()}`,
    topicEpoch: 0,
    execution: {
      conversationPrompts: [prompt],
      loggedUserMessageCount: 0,
      ...(threadRootId ? { threadRootId } : {}),
    },
  });
}

/** Every pending request for a topic, in queue order. */
function listPending(topicId: string): RuntimeUserTurnRequest[] {
  const ids = db
    .query<{ request_id: string }, string>(
      "SELECT request_id FROM runtime_user_turn_requests WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(topicId)
    .map((row) => row.request_id);
  const rows = db.query<
    { user_messages_json: string | null; execution_json: string | null },
    string
  >(
    "SELECT user_messages_json, execution_json FROM runtime_user_turn_requests WHERE request_id = ?",
  );
  return ids.map((requestId) => {
    const row = rows.get(requestId) as {
      user_messages_json: string | null;
      execution_json: string | null;
    };
    return {
      requestId,
      userMessages: JSON.parse(row.user_messages_json ?? "[]"),
      execution: row.execution_json ? JSON.parse(row.execution_json) : undefined,
    } as RuntimeUserTurnRequest;
  });
}

afterEach(() => {
  for (const topicId of topics.splice(0)) {
    db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ?").run(topicId);
  }
});

describe("pending turn requests never merge across threads", () => {
  test("two threads queue as two independent requests", () => {
    const topicId = `thread-merge-${randomUUID()}`;
    topics.push(topicId);
    submit(topicId, "first in thread A", "root-a");
    submit(topicId, "first in thread B", "root-b");

    const pending = listPending(topicId);
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.execution?.threadRootId).sort()).toEqual(["root-a", "root-b"]);
  });

  test("the channel and a thread do not fold into one turn", () => {
    const topicId = `thread-channel-${randomUUID()}`;
    topics.push(topicId);
    submit(topicId, "asked in the channel");
    submit(topicId, "asked in a thread", "root-a");

    const pending = listPending(topicId);
    expect(pending).toHaveLength(2);
    // A merged batch spanning both would have no correct place to answer.
    const channel = pending.find((r) => r.execution?.threadRootId === undefined);
    const threaded = pending.find((r) => r.execution?.threadRootId === "root-a");
    expect(channel?.userMessages.map((m) => m.prompt)).toEqual(["asked in the channel"]);
    expect(threaded?.userMessages.map((m) => m.prompt)).toEqual(["asked in a thread"]);
  });

  test("consecutive messages in the same thread still merge", () => {
    const topicId = `thread-same-${randomUUID()}`;
    topics.push(topicId);
    submit(topicId, "one", "root-a");
    submit(topicId, "two", "root-a");

    const pending = listPending(topicId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.userMessages.map((m) => m.prompt)).toEqual(["one", "two"]);
  });

  test("consecutive channel messages still merge", () => {
    const topicId = `channel-same-${randomUUID()}`;
    topics.push(topicId);
    submit(topicId, "one");
    submit(topicId, "two");

    const pending = listPending(topicId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.userMessages.map((m) => m.prompt)).toEqual(["one", "two"]);
  });
});

test("a malformed stored replyTo is rejected instead of crashing the renderer", () => {
  const topicId = `topic-${randomUUID()}`;
  topics.push(topicId);
  const requestId = `req-${randomUUID()}`;
  mergeRuntimeUserTurnRequest({
    topicId,
    userId: "local",
    userMessages: [{ prompt: "hello" }],
    allowAutoContinue: true,
    requestId,
    topicEpoch: 0,
    execution: { conversationPrompts: ["hello"], loggedUserMessageCount: 0 },
  });
  // Durable JSON outlives the code that wrote it. `label: 7` would reach
  // `label.trim()` in the prompt renderer and throw mid-turn.
  db.query("UPDATE runtime_user_turn_requests SET user_messages_json = ? WHERE request_id = ?").run(
    JSON.stringify([{ prompt: "hello", replyTo: { kind: "thread", label: 7 } }]),
    requestId,
  );

  // Read through the production path, not the raw JSON: the point is that the
  // validator refuses the row and falls back to the plain prompt.
  const request = getRuntimeUserTurnRequest(topicId);
  expect(request?.userMessages).toEqual([{ prompt: "hello" }]);
  expect(() => renderUserTurnBatch(request?.userMessages ?? [])).not.toThrow();
});

test("a well-formed stored replyTo round-trips", () => {
  const topicId = `topic-${randomUUID()}`;
  topics.push(topicId);
  const replyTo = { kind: "thread" as const, rootId: "root-1", label: "AI", text: "루트" };
  mergeRuntimeUserTurnRequest({
    topicId,
    userId: "local",
    userMessages: [{ prompt: "답장", replyTo }],
    allowAutoContinue: true,
    requestId: `req-${randomUUID()}`,
    topicEpoch: 0,
    execution: { conversationPrompts: ["답장"], loggedUserMessageCount: 0 },
  });

  const request = getRuntimeUserTurnRequest(topicId);
  expect(request?.userMessages[0].replyTo).toEqual(replyTo);
  expect(renderUserTurnBatch(request?.userMessages ?? [])).toContain("[In thread #root1 on @AI]");
});
