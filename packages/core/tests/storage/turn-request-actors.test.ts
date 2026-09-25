import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";
import {
  mergeRuntimeUserTurnRequest,
  type RuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";
import type { ActorTopicScope } from "#types";

const topics: string[] = [];

function submit(
  topicId: string,
  actorUserId: string,
  prompt: string,
  opts: { actorTopicScope?: ActorTopicScope; threadRootId?: string } = {},
) {
  return mergeRuntimeUserTurnRequest({
    topicId,
    userId: "local",
    userMessages: [{ prompt, actorUserId }],
    allowAutoContinue: true,
    requestId: `req-${randomUUID()}`,
    topicEpoch: 0,
    execution: {
      actorUserId,
      conversationPrompts: [prompt],
      loggedUserMessageCount: 0,
      ...(opts.actorTopicScope ? { actorTopicScope: opts.actorTopicScope } : {}),
      ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}),
    },
  });
}

/** Every pending request for a topic, in queue order. */
function listPending(topicId: string): RuntimeUserTurnRequest[] {
  return db
    .query<
      { request_id: string; user_messages_json: string | null; execution_json: string | null },
      string
    >(
      "SELECT request_id, user_messages_json, execution_json FROM runtime_user_turn_requests WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(topicId)
    .map(
      (row) =>
        ({
          requestId: row.request_id,
          userMessages: JSON.parse(row.user_messages_json ?? "[]"),
          execution: row.execution_json ? JSON.parse(row.execution_json) : undefined,
        }) as RuntimeUserTurnRequest,
    );
}

function newTopic(): string {
  const id = `actor-merge-${randomUUID()}`;
  topics.push(id);
  return id;
}

afterEach(() => {
  for (const topicId of topics.splice(0)) {
    db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ?").run(topicId);
  }
});

const aliceScope: ActorTopicScope = {
  visibleNodeTopicIds: ["room-a", "room-shared"],
  ownedNodeTopicIds: ["room-a"],
};
const bobScope: ActorTopicScope = {
  visibleNodeTopicIds: ["room-b", "room-shared"],
  ownedNodeTopicIds: ["room-b"],
};

/**
 * A merged batch runs under one actor and one room assertion. Folding two
 * people's pending messages into it would run the first person's words with
 * the second person's authority, so requests fold only within one actor.
 */
describe("pending turn requests never merge across actors", () => {
  test("A then B in the same conversation queue as two turns, each with its own actor and scope", () => {
    const topicId = newTopic();
    submit(topicId, "alice", "alice asks", { actorTopicScope: aliceScope });
    submit(topicId, "bob", "bob follows up", { actorTopicScope: bobScope });

    const pending = listPending(topicId);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      userMessages: [{ prompt: "alice asks", actorUserId: "alice" }],
      execution: { actorUserId: "alice", actorTopicScope: aliceScope },
    });
    expect(pending[1]).toMatchObject({
      userMessages: [{ prompt: "bob follows up", actorUserId: "bob" }],
      execution: { actorUserId: "bob", actorTopicScope: bobScope },
    });
    // Nothing of Alice's was folded into Bob's request.
    expect(pending[1]!.execution?.supersededRequestIds ?? []).toEqual([]);
  });

  test("the same actor's consecutive messages still fold into one batch", () => {
    const topicId = newTopic();
    const first = submit(topicId, "alice", "one", { actorTopicScope: aliceScope });
    const second = submit(topicId, "alice", "two", { actorTopicScope: aliceScope });

    const pending = listPending(topicId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).toBe(second.requestId);
    expect(pending[0]!.userMessages.map((message) => message.prompt)).toEqual(["one", "two"]);
    expect(pending[0]!.execution).toMatchObject({
      actorUserId: "alice",
      actorTopicScope: aliceScope,
      supersededRequestIds: [first.requestId],
    });
  });

  test("the same actor with two assertions runs with their intersection", () => {
    const topicId = newTopic();
    submit(topicId, "alice", "one", { actorTopicScope: aliceScope });
    submit(topicId, "alice", "two", {
      actorTopicScope: {
        visibleNodeTopicIds: ["room-shared", "room-new"],
        ownedNodeTopicIds: ["room-a", "room-new"],
      },
    });
    const [merged] = listPending(topicId);
    expect(merged?.execution?.actorTopicScope).toEqual({
      visibleNodeTopicIds: ["room-shared"],
      // Owned in the second but not visible in it: `owned` is intersected on
      // its own, so `room-a` survives only because both asserted it there.
      ownedNodeTopicIds: ["room-a"],
    });
  });

  test("a folded request without an assertion leaves the batch without one", () => {
    const topicId = newTopic();
    submit(topicId, "alice", "unscoped");
    submit(topicId, "alice", "scoped", { actorTopicScope: aliceScope });
    const [merged] = listPending(topicId);
    expect(merged?.userMessages.map((message) => message.prompt)).toEqual(["unscoped", "scoped"]);
    expect(merged?.execution?.actorTopicScope).toBeUndefined();
  });

  test("another actor in between ends the run: A, B, A queues as three turns in order", () => {
    const topicId = newTopic();
    submit(topicId, "alice", "a1", { actorTopicScope: aliceScope });
    submit(topicId, "bob", "b1", { actorTopicScope: bobScope });
    submit(topicId, "alice", "a2", { actorTopicScope: aliceScope });
    const pending = listPending(topicId);
    // Folding a2 onto a1 would move Alice's first message behind Bob's; the
    // queue keeps arrival order instead and a2 becomes its own turn.
    expect(pending.map((request) => request.userMessages[0]!.prompt)).toEqual(["a1", "b1", "a2"]);
    expect(pending.map((request) => request.execution?.actorUserId)).toEqual([
      "alice",
      "bob",
      "alice",
    ]);
    // Only the tail run folds: a3 joins a2, not a1.
    submit(topicId, "alice", "a3", { actorTopicScope: aliceScope });
    const after = listPending(topicId);
    expect(after.map((request) => request.userMessages.map((m) => m.prompt))).toEqual([
      ["a1"],
      ["b1"],
      ["a2", "a3"],
    ]);
  });

  test("actor boundaries and thread boundaries compose", () => {
    const topicId = newTopic();
    submit(topicId, "alice", "channel alice");
    submit(topicId, "alice", "thread alice", { threadRootId: "root" });
    submit(topicId, "bob", "thread bob", { threadRootId: "root" });
    submit(topicId, "alice", "channel alice again");
    const pending = listPending(topicId);
    expect(pending.map((request) => request.userMessages.map((m) => m.prompt))).toEqual([
      // The channel run of Alice folds across the thread messages in between:
      // a different thread is a different conversation, not a break in hers.
      ["thread alice"],
      ["thread bob"],
      ["channel alice", "channel alice again"],
    ]);
  });

  test("rows without a recorded actor fold together but never with a named actor", () => {
    const topicId = newTopic();
    mergeRuntimeUserTurnRequest({
      topicId,
      userId: "local",
      userMessages: [{ prompt: "legacy" }],
      allowAutoContinue: true,
      requestId: `req-${randomUUID()}`,
      topicEpoch: 0,
      execution: { conversationPrompts: ["legacy"], loggedUserMessageCount: 0 },
    });
    // Actor unrecorded on both (turns the node started for itself): still one
    // conversation, as the terminal/telegram steering path relies on.
    mergeRuntimeUserTurnRequest({
      topicId,
      userId: "local",
      userMessages: [{ prompt: "legacy too" }],
      allowAutoContinue: true,
      requestId: `req-${randomUUID()}`,
      topicEpoch: 0,
      execution: { conversationPrompts: ["legacy too"], loggedUserMessageCount: 0 },
    });
    expect(listPending(topicId).map((request) => request.userMessages.length)).toEqual([2]);
    // A named actor is never "the same person" as an unrecorded one — in either
    // direction — so neither folds into the other.
    submit(topicId, "alice", "named");
    expect(listPending(topicId).map((request) => request.userMessages.length)).toEqual([2, 1]);
    mergeRuntimeUserTurnRequest({
      topicId,
      userId: "local",
      userMessages: [{ prompt: "anonymous again" }],
      allowAutoContinue: true,
      requestId: `req-${randomUUID()}`,
      topicEpoch: 0,
      execution: { conversationPrompts: ["anonymous again"], loggedUserMessageCount: 0 },
    });
    expect(listPending(topicId).map((request) => request.userMessages.length)).toEqual([2, 1, 1]);
  });
});
