/**
 * Session-comm stress tests — concurrent ask/tell inject verification.
 *
 * Verifies the InterSessionQueue handles:
 *  - Mergeable-prefix merging (consecutive tells become one turn)
 *  - requestId dedup (same ask absorbed)
 *  - Concurrent-safe enqueue/dequeue sequencing
 *  - 10 concurrent injects without loss or corruption
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearRoomQuery,
  deferInject,
  getRoomQuery,
  interSessionQueue,
  setRoomQuery,
} from "#query/active-rooms";
import { AbortReason } from "#query/types";

function mockInject(idx: number, origin: string, requestId?: string) {
  return {
    topicId: "stress-topic",
    userId: "system",
    prompt: `message-${idx}`,
    origin,
    requestId: requestId ?? `${origin}-${idx}`,
    depth: 1,
    deferredAt: Date.now(),
  };
}

afterEach(() => {
  // Drain everything.
  const running = getRoomQuery("stress-topic");
  if (running) clearRoomQuery("stress-topic", running.queryId);
  while (interSessionQueue.dequeueAll("stress-topic")) {
    /* drain */
  }
});

describe("stress: concurrent tell injects (mergeable prefix)", () => {
  test("3 sequential tells with mergeable prompts produce single merged dequeue", () => {
    const injects = [mockInject(1, "topic-A"), mockInject(2, "topic-A"), mockInject(3, "topic-A")];
    for (const i of injects) deferInject(i);

    // dequeueAll merges contiguous same-origin, non-silent injects.
    const merged = interSessionQueue.dequeueAll("stress-topic");
    expect(merged).toBeDefined();
    expect(merged!.prompt).toContain("message-1");
    expect(merged!.prompt).toContain("message-2");
    expect(merged!.prompt).toContain("message-3");
    expect(merged!.origin).toBe("topic-A");
    // Queue should be empty now.
    expect(interSessionQueue.dequeueAll("stress-topic")).toBeUndefined();
  });

  test("tells with different origins are NOT merged", () => {
    deferInject(mockInject(1, "topic-A"));
    deferInject(mockInject(2, "topic-B"));
    // Only origin "topic-A" merges its own prefix.
    const merged = interSessionQueue.dequeueAll("stress-topic");
    expect(merged!.prompt).toContain("message-1");
    expect(merged!.prompt).not.toContain("message-2");
    // Second entry is still in queue.
    const second = interSessionQueue.dequeueAll("stress-topic");
    expect(second).toBeDefined();
    expect(second!.prompt).toContain("message-2");
    expect(interSessionQueue.dequeueAll("stress-topic")).toBeUndefined();
  });

  test("silent injects break merge chain", () => {
    deferInject({ ...mockInject(1, "topic-A"), silent: false });
    deferInject({ ...mockInject(2, "topic-A"), silent: true });
    deferInject({ ...mockInject(3, "topic-A"), silent: false });
    // First (non-silent) dequeues alone.
    const first = interSessionQueue.dequeueAll("stress-topic");
    expect(first!.prompt).toContain("message-1");
    // Silent breaks chain.
    const second = interSessionQueue.dequeueAll("stress-topic");
    expect(second!.prompt).toContain("message-2");
    expect(second!.silent).toBe(true);
    // Third dequeues separately because silent broke the merge.
    const third = interSessionQueue.dequeueAll("stress-topic");
    expect(third!.prompt).toContain("message-3");
    expect(interSessionQueue.dequeueAll("stress-topic")).toBeUndefined();
  });

  test("10 concurrent tells → all merged or dequeued correctly", async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => deferInject(mockInject(i, "topic-X"))),
    );
    await Promise.all(promises);
    // First dequeueAll merges the whole chain (same origin, non-silent, contiguous).
    const merged = interSessionQueue.dequeueAll("stress-topic");
    expect(merged).toBeDefined();
    for (let i = 0; i < 10; i++) {
      expect(merged!.prompt).toContain(`message-${i}`);
    }
    expect(interSessionQueue.dequeueAll("stress-topic")).toBeUndefined();
  });
});

describe("stress: requestId dedup", () => {
  test("duplicate requestIds are absorbed — same origin merges all", () => {
    const rid = "dup-req";
    deferInject(mockInject(1, "topic-A", rid));
    deferInject(mockInject(2, "topic-A", rid)); // duplicate → absorbed
    deferInject(mockInject(3, "topic-A", rid)); // duplicate → absorbed
    deferInject(mockInject(4, "topic-A", "uniq"));
    // All share origin "topic-A" → merged into one by dequeueAll.
    const merged = interSessionQueue.dequeueAll("stress-topic");
    expect(merged).toBeDefined();
    expect(merged!.prompt).toContain("message-1");
    expect(merged!.prompt).toContain("message-4");
    // Dedup: message-2 and message-3 should NOT appear.
    expect(merged!.prompt).not.toContain("message-2");
    expect(merged!.prompt).not.toContain("message-3");
    expect(merged!.origin).toBe("topic-A");
    expect(interSessionQueue.dequeueAll("stress-topic")).toBeUndefined();
  });

  test("10 concurrent dedup — only unique requestIds survive", async () => {
    const uids = ["a", "a", "b", "b", "c", "c", "d", "d", "e", "e"]; // 5 unique
    await Promise.all(
      uids.map((rid, i) =>
        Promise.resolve().then(() => deferInject(mockInject(i, "topic-Z", rid))),
      ),
    );
    const merged = interSessionQueue.dequeueAll("stress-topic");
    expect(merged).toBeDefined();
    // 5 unique requestIds → should contain message-0,2,4,6,8 (first of each pair).
    expect(merged!.prompt).toContain("message-0");
    expect(merged!.prompt).toContain("message-2");
    expect(merged!.prompt).toContain("message-4");
    expect(merged!.prompt).toContain("message-6");
    expect(merged!.prompt).toContain("message-8");
    // Queue should be empty.
    expect(interSessionQueue.dequeueAll("stress-topic")).toBeUndefined();
  });
});

describe("stress: mixed ask+user race", () => {
  test("user turn preempts inject, inject gets deferred and dequeues after clear", () => {
    setRoomQuery({
      topicId: "stress-topic",
      queryId: "running-user",
      origin: "user",
      prompt: "running prompt",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    });

    // Session inject should defer (user is running).
    deferInject(mockInject(1, "source-topic", "ask-1"));
    expect(getRoomQuery("stress-topic")?.queryId).toBe("running-user");
    // Drain the deferred inject.
    const deferred = interSessionQueue.dequeueAll("stress-topic");
    expect(deferred).toBeDefined();
    expect(deferred!.requestId).toBe("ask-1");
    expect(deferred!.origin).toBe("source-topic");
    expect(interSessionQueue.dequeueAll("stress-topic")).toBeUndefined();
  });
});
