/**
 * Unit tests for InterSessionQueue.
 * `tests/mcp/session-comm/inter-session-queue.test.ts`.
 *
 * Covers: enqueue dedup, dequeueNext FIFO, dequeueAll merge,
 * keysForRoom, contextId reconciliation, silent separation,
 * ask-reply vs ordinary-inject separation, size.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type DeferredInject, DeferredInjectBatcher, InterSessionQueue } from "#query/active-rooms";

const TOPIC = "t-queue";

function inject(overrides: Partial<DeferredInject> = {}): DeferredInject {
  return {
    topicId: TOPIC,
    userId: "system",
    prompt: "hi",
    origin: "sender",
    requestId: `r-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

const queue = new InterSessionQueue();
afterEach(() => {
  queue.drop(TOPIC);
});

describe("enqueue", () => {
  test("rejects entries without requestId", () => {
    const ok = queue.enqueue(TOPIC, inject({ requestId: undefined as unknown as string }));
    expect(ok).toBe(false);
    expect(queue.keysForRoom()).toEqual([]);
  });

  test("deduplicates by requestId", () => {
    const i = inject({ requestId: "dup-1", prompt: "first" });
    expect(queue.enqueue(TOPIC, i)).toBe(true);
    expect(queue.enqueue(TOPIC, { ...i, prompt: "second" })).toBe(false);
    const d = queue.dequeueNext(TOPIC);
    expect(d?.prompt).toBe("first");
    expect(queue.dequeueNext(TOPIC)).toBeUndefined();
  });

  test("hasRequest tracks queued requestId", () => {
    queue.enqueue(TOPIC, inject({ requestId: "has-1" }));
    expect(queue.hasRequest(TOPIC, "has-1")).toBe(true);
    expect(queue.hasRequest(TOPIC, "nonexistent")).toBe(false);
    queue.dequeueNext(TOPIC);
    expect(queue.hasRequest(TOPIC, "has-1")).toBe(false);
  });
});

describe("dequeueNext", () => {
  test("returns undefined for non-existent topic", () => {
    expect(queue.dequeueNext("nonexistent")).toBeUndefined();
  });

  test("preserves FIFO order", () => {
    queue.enqueue(TOPIC, inject({ requestId: "1", prompt: "a" }));
    queue.enqueue(TOPIC, inject({ requestId: "2", prompt: "b" }));
    queue.enqueue(TOPIC, inject({ requestId: "3", prompt: "c" }));
    expect(queue.dequeueNext(TOPIC)?.requestId).toBe("1");
    expect(queue.dequeueNext(TOPIC)?.requestId).toBe("2");
    expect(queue.dequeueNext(TOPIC)?.requestId).toBe("3");
    expect(queue.dequeueNext(TOPIC)).toBeUndefined();
  });

  test("drops empty topic key from listing", () => {
    queue.enqueue(TOPIC, inject({ requestId: "drop-1" }));
    expect(queue.keysForRoom()).toContain(TOPIC);
    queue.dequeueNext(TOPIC);
    expect(queue.keysForRoom()).not.toContain(TOPIC);
  });
});

describe("keysForRoom", () => {
  const q2 = new InterSessionQueue();
  afterEach(() => {
    q2.drop("t-a");
    q2.drop("t-b");
  });

  test("only returns keys with pending entries", () => {
    q2.enqueue("t-a", { ...inject(), topicId: "t-a", requestId: "ka" });
    q2.enqueue("t-b", { ...inject(), topicId: "t-b", requestId: "kb" });
    expect(q2.keysForRoom().sort()).toEqual(["t-a", "t-b"]);
  });
});

describe("dequeueAll", () => {
  test("merges same-origin prompts", () => {
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "p1", requestId: "r1" }));
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "p2", requestId: "r2" }));
    const m = queue.dequeueAll(TOPIC);
    expect(m?.prompt).toBe("p1\n\np2");
    expect(m?.origin).toBe("s1");
    expect(m?.requestId?.startsWith("merged-")).toBe(true);
    expect(queue.dequeueAll(TOPIC)).toBeUndefined();
  });

  test("preserves contextId when batch agrees", () => {
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "a", requestId: "a1", contextId: "c1" }));
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "b", requestId: "a2", contextId: "c1" }));
    expect(queue.dequeueAll(TOPIC)?.contextId).toBe("c1");
  });

  test("drops contextId when batch disagrees", () => {
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "a", requestId: "a1", contextId: "c1" }));
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "b", requestId: "a2", contextId: "c2" }));
    expect(queue.dequeueAll(TOPIC)?.contextId).toBeUndefined();
  });

  test("stops merging at different origin", () => {
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "p1", requestId: "r1" }));
    queue.enqueue(TOPIC, inject({ origin: "s2", prompt: "p2", requestId: "r2" }));
    const first = queue.dequeueAll(TOPIC)!;
    expect(first.origin).toBe("s1");
    expect(first.prompt).toBe("p1");
    const second = queue.dequeueAll(TOPIC)!;
    expect(second.origin).toBe("s2");
    expect(second.prompt).toBe("p2");
    expect(queue.dequeueAll(TOPIC)).toBeUndefined();
  });

  test("never merges silent with non-silent", () => {
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "ask", requestId: "r1", silent: true }));
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "tell", requestId: "r2", silent: false }));
    expect(queue.dequeueAll(TOPIC)?.silent).toBe(true);
    expect(queue.dequeueAll(TOPIC)?.silent).toBe(false);
  });

  test("does not merge different onDispatched presence", () => {
    queue.enqueue(
      TOPIC,
      inject({ origin: "s1", prompt: "a", requestId: "r1", onDispatched: () => {} }),
    );
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "b", requestId: "r2" }));
    expect(queue.dequeueAll(TOPIC)?.prompt).toBe("a");
    expect(queue.dequeueAll(TOPIC)?.prompt).toBe("b");
  });

  test("merges ask replies from different source topics", () => {
    queue.enqueue(
      TOPIC,
      inject({
        origin: "design",
        prompt: "[Reply from design]\n\nok",
        requestId: "ask-r1",
        contextId: "ctx",
        askReplySources: [{ from: "design", requestId: "ask-r1", contextId: "ctx" }],
      }),
    );
    queue.enqueue(
      TOPIC,
      inject({
        origin: "research",
        prompt: "[Reply from research]\n\nnoted",
        requestId: "ask-r2",
        contextId: "ctx",
        askReplySources: [{ from: "research", requestId: "ask-r2", contextId: "ctx" }],
      }),
    );

    const merged = queue.dequeueAll(TOPIC)!;
    expect(merged.prompt).toContain("[Reply from design]");
    expect(merged.prompt).toContain("[Reply from research]");
    expect(merged.origin).toBe("design, research");
    expect(merged.askReplySources?.map((source) => source.from)).toEqual(["design", "research"]);
    expect(merged.contextId).toBe("ctx");
  });

  test("composes onDispatched callbacks", () => {
    const calls: string[] = [];
    queue.enqueue(
      TOPIC,
      inject({
        origin: "s1",
        prompt: "a",
        requestId: "r1",
        onDispatched: (qid) => calls.push(`a:${qid}`),
      }),
    );
    queue.enqueue(
      TOPIC,
      inject({
        origin: "s1",
        prompt: "b",
        requestId: "r2",
        onDispatched: (qid) => calls.push(`b:${qid}`),
      }),
    );
    queue.dequeueAll(TOPIC)?.onDispatched?.("q");
    expect(calls).toEqual(["a:q", "b:q"]);
  });

  test("single entry returns with original requestId", () => {
    queue.enqueue(TOPIC, inject({ origin: "s1", prompt: "solo", requestId: "original" }));
    const m = queue.dequeueAll(TOPIC)!;
    expect(m.requestId).toBe("original");
    expect(m.prompt).toBe("solo");
  });
});

describe("size", () => {
  test("reports correct count across operations", () => {
    expect(queue.size(TOPIC)).toBe(0);
    queue.enqueue(TOPIC, inject({ requestId: "s1" }));
    queue.enqueue(TOPIC, inject({ requestId: "s2" }));
    expect(queue.size(TOPIC)).toBe(2);
    queue.dequeueAll(TOPIC);
    expect(queue.size(TOPIC)).toBe(0);
  });
});

describe("DeferredInjectBatcher", () => {
  test("holds the first idle-room ask reply and dispatches one merged caller turn", () => {
    const q = new InterSessionQueue();
    const scheduled: Array<() => void> = [];
    const dispatched: DeferredInject[] = [];
    const batcher = new DeferredInjectBatcher({
      queue: q,
      delayMs: 500,
      isBusy: () => false,
      dispatch: (entry) => dispatched.push(entry),
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
    });

    const reply = (from: string, requestId: string): DeferredInject => ({
      topicId: TOPIC,
      userId: "caller",
      prompt: `[Reply from ${from}]`,
      origin: from,
      requestId,
      askReplySources: [{ from, requestId }],
      onDispatched: () => {},
    });

    expect(batcher.enqueue(reply("design", "ask-1"))).toBe(true);
    expect(batcher.enqueue(reply("research", "ask-2"))).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(dispatched).toHaveLength(0);

    scheduled[0]();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].prompt).toContain("Reply from design");
    expect(dispatched[0].prompt).toContain("Reply from research");
    expect(dispatched[0].askReplySources?.map((source) => source.requestId)).toEqual([
      "ask-1",
      "ask-2",
    ]);
    expect(q.size(TOPIC)).toBe(0);
  });

  test("leaves the batch queued when the caller room is busy", () => {
    const q = new InterSessionQueue();
    let scheduled: (() => void) | undefined;
    const dispatched: DeferredInject[] = [];
    const batcher = new DeferredInjectBatcher({
      queue: q,
      delayMs: 500,
      isBusy: () => true,
      dispatch: (entry) => dispatched.push(entry),
      schedule: (callback) => {
        scheduled = callback;
        return callback;
      },
    });

    batcher.enqueue(inject({ requestId: "busy-1" }));
    scheduled?.();

    expect(dispatched).toHaveLength(0);
    expect(q.size(TOPIC)).toBe(1);
    expect(q.dequeueAll(TOPIC)?.requestId).toBe("busy-1");
  });

  test("uses the request-id index after head dequeues and removals", () => {
    const q = new InterSessionQueue();
    for (let i = 0; i < 130; i++) {
      q.enqueue(TOPIC, inject({ requestId: `indexed-${i}`, prompt: String(i) }));
    }
    for (let i = 0; i < 70; i++) {
      expect(q.dequeueNext(TOPIC)?.requestId).toBe(`indexed-${i}`);
    }

    expect(q.hasRequest(TOPIC, "indexed-100")).toBe(true);
    expect(q.remove(TOPIC, "indexed-100")?.prompt).toBe("100");
    expect(q.hasRequest(TOPIC, "indexed-100")).toBe(false);
    expect(q.size(TOPIC)).toBe(59);
  });
});
