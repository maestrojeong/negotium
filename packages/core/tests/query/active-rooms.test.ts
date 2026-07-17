/**
 * Unit tests for the room-keyed in-flight registry + abort-on-new-message
 * priority + InterSessionQueue (`@/query/active-rooms`). Ported semantics
 * from Otium `telegram/query/handler.ts` L175-208 and `control.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  abortAllRooms,
  cancelDeferredInject,
  clearRoomQuery,
  decideNewQuery,
  deferInject,
  getRoomQuery,
  getRoomQueryStatus,
  InterSessionQueue,
  interSessionQueue,
  isolatedTurnRoomId,
  isTopicRunning,
  isUserOrigin,
  listRunningTopicIds,
  listRunningTopicQueries,
  type RoomQueryControl,
  setRoomQuery,
  takeDeferredInject,
  wsAbortReason,
} from "#query/active-rooms";
import { AbortReason } from "#query/types";

const RID = (n: number) => `req-${n}`;

function makeControl(topicId: string, queryId: string, origin: string): RoomQueryControl {
  return {
    topicId,
    queryId,
    origin,
    prompt: "prompt",
    abortController: new AbortController(),
    abortReason: AbortReason.None,
    injectParams: isUserOrigin(origin)
      ? undefined
      : { topicId, userId: "u", prompt: "p", origin, requestId: RID(1) },
  };
}

afterEach(() => {
  for (const t of ["r1", "r2", "r3", "r4", "r5", "r6"]) {
    const c = getRoomQuery(t);
    if (c) clearRoomQuery(t, c.queryId);
    while (takeDeferredInject(t)) {
      /* drain */
    }
  }
});

// ── decideNewQuery (B) ──
describe("decideNewQuery", () => {
  test("idle room → proceed", () => {
    expect(decideNewQuery("r1", "user")).toEqual({ action: "proceed" });
  });

  test("user message preempts a running user turn → abort-replace", () => {
    setRoomQuery(makeControl("r2", "q1", "user"));
    const d = decideNewQuery("r2", "user");
    expect(d.action).toBe("abort-replace");
    if (d.action === "abort-replace") expect(d.running.queryId).toBe("q1");
  });

  test("user message preempts a running session-inject → abort-replace", () => {
    setRoomQuery(makeControl("r3", "q1", "from-topic"));
    const d = decideNewQuery("r3", "user");
    expect(d.action).toBe("abort-replace");
  });

  test("session-inject yields to a running user turn → defer", () => {
    setRoomQuery(makeControl("r4", "q1", "user"));
    expect(decideNewQuery("r4", "from-topic")).toEqual({ action: "defer" });
  });

  test("session-inject yields to another running session-inject → defer", () => {
    setRoomQuery(makeControl("r5", "q1", "from-topic"));
    expect(decideNewQuery("r5", "from-topic2")).toEqual({ action: "defer" });
  });

  test("isolated ask room proceeds while the visible topic room is busy", () => {
    const topicId = "r4";
    const askRoomId = isolatedTurnRoomId(topicId, "q-ask");
    const askControl = {
      ...makeControl(topicId, "q-ask", "caller-topic"),
      roomId: askRoomId,
    };
    setRoomQuery(makeControl(topicId, "q-user", "user"));

    try {
      expect(decideNewQuery(topicId, "caller-topic")).toEqual({ action: "defer" });
      expect(decideNewQuery(askRoomId, "caller-topic")).toEqual({ action: "proceed" });
      expect(setRoomQuery(askControl)).toBe(true);
      expect(getRoomQuery(topicId)?.queryId).toBe("q-user");
      expect(getRoomQuery(askRoomId)?.queryId).toBe("q-ask");
      expect(listRunningTopicQueries().get(topicId)).toBe("q-user");
    } finally {
      clearRoomQuery(askRoomId, "q-ask");
      clearRoomQuery(topicId, "q-user");
    }
  });
});

describe("clearRoomQuery (stale guard)", () => {
  test("does not clobber a newer replacement turn", () => {
    setRoomQuery(makeControl("r6", "old", "user"));
    setRoomQuery(makeControl("r6", "new", "user"));
    clearRoomQuery("r6", "old");
    expect(getRoomQuery("r6")?.queryId).toBe("new");
    clearRoomQuery("r6", "new");
    expect(getRoomQuery("r6")).toBeUndefined();
  });
});

describe("abortAllRooms", () => {
  test("aborts every active room for graceful node shutdown", () => {
    const first = makeControl("r1", "q1", "user");
    const second = makeControl("r2", "q2", "from-topic");
    setRoomQuery(first);
    setRoomQuery(second);

    expect(abortAllRooms()).toBe(2);
    expect(first.abortController.signal.aborted).toBe(true);
    expect(second.abortController.signal.aborted).toBe(true);
    expect(first.abortReason).toBe(AbortReason.External);
    expect(second.abortReason).toBe(AbortReason.External);
    expect(abortAllRooms()).toBe(0);
  });
});

describe("getRoomQueryStatus", () => {
  test("reports only the matching in-flight query as running", () => {
    setRoomQuery(makeControl("r6", "live", "user"));
    expect(getRoomQueryStatus("r6", "live")).toBe("running");
    expect(getRoomQueryStatus("r6", "old")).toBe("not_found");
    expect(getRoomQueryStatus("missing", "live")).toBe("not_found");
    clearRoomQuery("r6", "live");
  });
});

// ── defer FIFO (bridged to InterSessionQueue) ──
describe("defer queue (FIFO)", () => {
  test("preserves order and empties out", () => {
    deferInject({ topicId: "r1", userId: "u", prompt: "first", origin: "a", requestId: RID(1) });
    deferInject({ topicId: "r1", userId: "u", prompt: "second", origin: "b", requestId: RID(2) });
    expect(takeDeferredInject("r1")?.prompt).toBe("first");
    expect(takeDeferredInject("r1")?.prompt).toBe("second");
    expect(takeDeferredInject("r1")).toBeUndefined();
  });

  test("returns undefined for empty room", () => {
    expect(takeDeferredInject("nonexistent")).toBeUndefined();
  });

  test("cancels one bounded background inject without disturbing its neighbors", () => {
    deferInject({ topicId: "r1", userId: "u", prompt: "first", origin: "a", requestId: RID(1) });
    deferInject({ topicId: "r1", userId: "u", prompt: "second", origin: "b", requestId: RID(2) });

    expect(cancelDeferredInject("r1", RID(1))).toBe(true);
    expect(cancelDeferredInject("r1", "missing")).toBe(false);
    expect(takeDeferredInject("r1")?.prompt).toBe("second");
  });
});

// ── InterSessionQueue (D) ──
describe("InterSessionQueue (D)", () => {
  test("dedup: same requestId in same room is ignored", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "A", origin: "x", requestId: "dup" });
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "B", origin: "x", requestId: "dup" });
    expect(q.dequeueAll("r1")?.prompt).toBe("A");
    expect(q.size("r1")).toBe(0);
  });

  test("dedup: different requestIds both queued (mergeable)", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "A", origin: "x", requestId: RID(1) });
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "B", origin: "x", requestId: RID(2) });
    // Same origin, same silent → merged into one entry
    const merged = q.dequeueAll("r1");
    expect(merged?.prompt).toBe("A\n\nB");
    expect(q.size("r1")).toBe(0);
  });

  test("dedup: requestId scope is per-room", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "A", origin: "x", requestId: "dup" });
    q.enqueue("r2", { topicId: "r2", userId: "u", prompt: "B", origin: "x", requestId: "dup" });
    expect(q.dequeueAll("r1")?.prompt).toBe("A");
    expect(q.dequeueAll("r2")?.prompt).toBe("B");
  });

  test("merge: queue entries from same source merge by prefix", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "X1", origin: "src", requestId: RID(1) });
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "X2", origin: "src", requestId: RID(2) });
    expect(q.dequeueAll("r1")?.prompt).toBe("X1\n\nX2");
  });

  test("merge: different source topics remain separate", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "A", origin: "src1", requestId: RID(1) });
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "B", origin: "src2", requestId: RID(2) });
    // Different origins → only first one dequeued
    expect(q.dequeueAll("r1")?.prompt).toBe("A");
    expect(q.size("r1")).toBe(1);
  });

  test("merge: forked session injects with different sessions remain separate", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", {
      topicId: "r1",
      userId: "u",
      prompt: "A",
      origin: "src",
      requestId: RID(1),
      silent: true,
      sessionId: "fork-a",
    });
    q.enqueue("r1", {
      topicId: "r1",
      userId: "u",
      prompt: "B",
      origin: "src",
      requestId: RID(2),
      silent: true,
      sessionId: "fork-b",
    });

    expect(q.dequeueAll("r1")?.prompt).toBe("A");
    expect(q.dequeueAll("r1")?.prompt).toBe("B");
  });

  test("merge: lazy ask forks with different snapshot recipes remain separate", () => {
    const q = new InterSessionQueue();
    const prepareA = async () => ({ agent: "maestro" as const, forkId: "a", rolloutPath: "/a" });
    const prepareB = async () => ({ agent: "maestro" as const, forkId: "b", rolloutPath: "/b" });
    q.enqueue("r1", {
      topicId: "r1",
      userId: "u",
      prompt: "A",
      origin: "src",
      requestId: RID(1),
      silent: true,
      prepareSession: prepareA,
    });
    q.enqueue("r1", {
      topicId: "r1",
      userId: "u",
      prompt: "B",
      origin: "src",
      requestId: RID(2),
      silent: true,
      prepareSession: prepareB,
    });

    expect(q.dequeueAll("r1")?.prepareSession).toBe(prepareA);
    expect(q.dequeueAll("r1")?.prepareSession).toBe(prepareB);
  });

  test("dequeueAll empties the room queue", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "A", origin: "src", requestId: RID(1) });
    q.dequeueAll("r1");
    expect(q.dequeueAll("r1")).toBeUndefined();
  });

  test("hasRequest returns true after enqueue, false after dequeue", () => {
    const q = new InterSessionQueue();
    q.enqueue("r1", { topicId: "r1", userId: "u", prompt: "A", origin: "src", requestId: "chk" });
    expect(q.hasRequest("r1", "chk")).toBe(true);
    q.dequeueAll("r1");
    expect(q.hasRequest("r1", "chk")).toBe(false);
  });

  test("global interSessionQueue singleton works", () => {
    interSessionQueue.enqueue("r-global", {
      topicId: "r-global",
      userId: "u",
      prompt: "G",
      origin: "x",
      requestId: "g1",
    });
    expect(interSessionQueue.dequeueAll("r-global")?.prompt).toBe("G");
  });
});

describe("wsAbortReason", () => {
  test("Internal → superseded, External/None → stopped", () => {
    expect(wsAbortReason(AbortReason.Internal)).toBe("superseded");
    expect(wsAbortReason(AbortReason.External)).toBe("stopped");
    expect(wsAbortReason(AbortReason.None)).toBe("stopped");
  });
});

describe("listRunningTopicIds", () => {
  test("reports a claimed room and clears once released", () => {
    setRoomQuery(makeControl("r1", "q1", "user"));
    expect(listRunningTopicIds().has("r1")).toBe(true);
    expect(listRunningTopicQueries().get("r1")).toBe("q1");
    expect(isTopicRunning("r1")).toBe(true);

    clearRoomQuery("r1", "q1");
    expect(listRunningTopicIds().has("r1")).toBe(false);
    expect(isTopicRunning("r1")).toBe(false);
  });
});

describe("isUserOrigin", () => {
  test("'user' and undefined are user origins; topic names are not", () => {
    expect(isUserOrigin("user")).toBe(true);
    expect(isUserOrigin(undefined)).toBe(true);
    expect(isUserOrigin("from-topic")).toBe(false);
  });
});
