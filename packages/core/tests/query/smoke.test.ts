/**
 * E2E Smoke Test — exercises the full 4-backbone pipeline (A/B/C/D)
 * without a running HTTP server. All Otium semantics verified.
 *
 * A) activeQueries — room-keyed in-flight 1개
 * B) abort-on-new-message — user>user=superseded, session>user=defer
 * C) session-inbox — deferInject/takeDeferredInject bridged to InterSessionQueue
 * D) InterSessionQueue — requestId dedup, mergeable-prefix dequeueAll
 */
import { describe, expect, test } from "bun:test";
import {
  abortRoom,
  clearRoomQuery,
  decideNewQuery,
  deferInject,
  getRoomQuery,
  InterSessionQueue,
  setRoomQuery,
  takeDeferredInject,
  wsAbortReason,
} from "#query/active-rooms";
import { AbortReason } from "#query/types";

type Control = NonNullable<ReturnType<typeof getRoomQuery>>;

// ── Helpers ──
function makeUserControl(topicId: string, queryId: string): Control {
  const ctrl = {
    topicId,
    queryId,
    origin: "user",
    prompt: "user prompt",
    abortController: new AbortController(),
    abortReason: AbortReason.None,
    injectParams: undefined as undefined,
  };
  setRoomQuery(ctrl);
  return ctrl;
}

function makeInjectControl(topicId: string, queryId: string, from: string): Control {
  const ctrl = {
    topicId,
    queryId,
    origin: from,
    prompt: "inject",
    abortController: new AbortController(),
    abortReason: AbortReason.None,
    injectParams: {
      topicId,
      userId: "system",
      prompt: "inject",
      origin: from,
      requestId: `rid-${queryId}`,
    },
  };
  setRoomQuery(ctrl);
  return ctrl;
}

// ── Scenario 1: User preempts running user (B) ──
describe("E2E: User preempts running user", () => {
  test("second message aborts first, takes over the room", () => {
    const t = "e2e-room-1";
    makeUserControl(t, "q-first");
    const d = decideNewQuery(t, "user");
    expect(d.action).toBe("abort-replace");
    if (d.action === "abort-replace") {
      d.running.abortController.abort();
      d.running.abortReason = AbortReason.Internal;
    }
    // Old turn's cleanup should NOT remove the replacement.
    clearRoomQuery(t, "q-first");
    // After abort-replace decision but before replacement is set,
    // the room should still have the old control (it's only cleared with its own queryId).
    // After abort-replace + clearRoomQuery with matching qid, room is empty.
    expect(getRoomQuery(t)).toBeUndefined();
    setRoomQuery({
      topicId: t,
      queryId: "q-second",
      origin: "user",
      prompt: "second prompt",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
      injectParams: undefined,
    });
    expect(getRoomQuery(t)?.queryId).toBe("q-second");
    // Old turn cleanup must not clobber replacement.
    clearRoomQuery(t, "q-first");
    expect(getRoomQuery(t)?.queryId).toBe("q-second");
    // Cleanup.
    clearRoomQuery(t, "q-second");
  });
});

// ── Scenario 2: User preempts running session-inject (B) ──
describe("E2E: User preempts running inject", () => {
  test("user message aborts inject, inject re-enqueued for later", () => {
    const t = "e2e-room-2";
    const ctrl = makeInjectControl(t, "q-inject", "회의록");
    const d = decideNewQuery(t, "user");
    expect(d.action).toBe("abort-replace");
    if (d.action !== "abort-replace") throw new Error("expected abort-replace");
    // Re-queue the inject.
    if (d.action === "abort-replace" && ctrl.injectParams) {
      deferInject(ctrl.injectParams);
    }
    d.running.abortController.abort();
    d.running.abortReason = AbortReason.Internal;
    clearRoomQuery(t, "q-inject");
    // Replacement user turn.
    setRoomQuery({
      topicId: t,
      queryId: "q-user",
      origin: "user",
      prompt: "user prompt",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
      injectParams: undefined,
    });
    // Deferred inject should be waiting.
    const deferred = takeDeferredInject(t);
    expect(deferred?.prompt).toBe("inject");
    expect(deferred?.origin).toBe("회의록");
    clearRoomQuery(t, "q-user");
  });
});

// ── Scenario 3: Session-inject yields to running user (B: user priority) ──
describe("E2E: Inject defers behind user turn", () => {
  test("inject is deferred, not aborted", () => {
    const t = "e2e-room-3";
    makeUserControl(t, "q-user");
    const d = decideNewQuery(t, "회의록");
    expect(d.action).toBe("defer");
    // Defer the inject.
    deferInject({
      topicId: t,
      userId: "system",
      prompt: "ask reply",
      origin: "회의록",
      requestId: "r1",
    });
    expect(takeDeferredInject(t)?.prompt).toBe("ask reply");
    clearRoomQuery(t, "q-user");
  });
});

// ── Scenario 4: InterSessionQueue dedup + merge + drain (D) ──
describe("E2E: InterSessionQueue full flow", () => {
  test("dedup same requestId, merge same-source, drain to user cap", () => {
    const t = "e2e-room-4";
    const q = new InterSessionQueue();

    // 3 tells from same source → merged.
    q.enqueue(t, { topicId: t, userId: "system", prompt: "T1", origin: "src", requestId: "a1" });
    q.enqueue(t, { topicId: t, userId: "system", prompt: "T2", origin: "src", requestId: "a2" });
    q.enqueue(t, { topicId: t, userId: "system", prompt: "T3", origin: "src", requestId: "a3" });

    // Duplicate — same requestId → ignored.
    q.enqueue(t, {
      topicId: t,
      userId: "system",
      prompt: "T2-DUP",
      origin: "src",
      requestId: "a2",
    });
    expect(q.size(t)).toBe(3);

    // On turn finish: drainAll.
    const batch = q.dequeueAll(t)!;
    expect(batch.prompt).toBe("T1\n\nT2\n\nT3");
    expect(batch.origin).toBe("src");
    expect(q.size(t)).toBe(0);
  });
});

// ── Scenario 5: Stale cleanup guard (A) ──
describe("E2E: Stale cleanup guard", () => {
  test("expired turn is cleaned up, replacement survives", async () => {
    const t = "e2e-room-5";
    makeUserControl(t, "stale");
    // Abort with external reason.
    abortRoom(t, AbortReason.External);
    // Stale turn's cleanup should not crash.
    clearRoomQuery(t, "stale");
    expect(getRoomQuery(t)).toBeUndefined();
    // Replacement should start clean.
    setRoomQuery({
      topicId: t,
      queryId: "fresh",
      origin: "user",
      prompt: "fresh prompt",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
      injectParams: undefined,
    });
    expect(getRoomQuery(t)?.queryId).toBe("fresh");
    clearRoomQuery(t, "fresh");
  });
});

// ── Scenario 6: WS reason mapping (B) ──
describe("E2E: WS abort reason", () => {
  test("Internal→superseded, External→stopped, None→stopped", () => {
    expect(wsAbortReason(AbortReason.Internal)).toBe("superseded");
    expect(wsAbortReason(AbortReason.External)).toBe("stopped");
    expect(wsAbortReason(AbortReason.None)).toBe("stopped");
  });
});

// ── Scenario 7: Full Otium parity flow ──
describe("E2E: Full Otium parity", () => {
  test("user→supersede-inject→defer→user→supersede", () => {
    const t = "e2e-room-7";

    // 1. User turn starts.
    makeUserControl(t, "q1");
    expect(getRoomQuery(t)?.origin).toBe("user");

    // 2. Session inject arrives → deferred.
    let d = decideNewQuery(t, "from-topic");
    expect(d.action).toBe("defer");
    deferInject({
      topicId: t,
      userId: "system",
      prompt: "ask",
      origin: "from-topic",
      requestId: "rid1",
    });

    // 3. User turn finishes, deferred inject is taken.
    clearRoomQuery(t, "q1");
    const deferred = takeDeferredInject(t);
    expect(deferred).toBeDefined();
    expect(deferred!.origin).toBe("from-topic");

    // 4. Inject turn starts.
    setRoomQuery({
      topicId: t,
      queryId: "q2",
      origin: "from-topic",
      prompt: "ask",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
      injectParams: {
        topicId: t,
        userId: "system",
        prompt: "ask",
        origin: "from-topic",
        requestId: "rid1",
      },
    });

    // 5. New user message → aborts inject, re-queues it.
    d = decideNewQuery(t, "user");
    expect(d.action).toBe("abort-replace");
    if (d.action !== "abort-replace") throw new Error("expected abort-replace");
    if (d.action === "abort-replace" && d.running.injectParams) {
      deferInject(d.running.injectParams);
    }
    d.running.abortController.abort();
    clearRoomQuery(t, "q2");

    // 6. User turn replaces.
    setRoomQuery({
      topicId: t,
      queryId: "q3",
      origin: "user",
      prompt: "user prompt",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
      injectParams: undefined,
    });
    expect(getRoomQuery(t)?.origin).toBe("user");

    // 7. After user finishes, deferred inject is waiting.
    clearRoomQuery(t, "q3");
    const deferred2 = takeDeferredInject(t);
    expect(deferred2?.prompt).toBe("ask");
    expect(takeDeferredInject(t)).toBeUndefined();
  });
});
