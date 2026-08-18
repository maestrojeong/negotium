import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendRuntimeEvent,
  heartbeatRuntimeEventConsumer,
  listRuntimeEventsAfter,
  pruneRuntimeEvents,
} from "../../src/storage/runtime-events";

test("runtime event pruning respects an active durable consumer cursor", () => {
  const topicId = randomUUID();
  const consumerId = `retention-test-${randomUUID()}`;
  const events = Array.from({ length: 5 }, (_, index) =>
    appendRuntimeEvent("retention-test", {
      type: "ai-status",
      topicId,
      payload: { index },
    }),
  );
  const first = events[0]!;
  const last = events.at(-1)!;
  // Other test adapters may have left fresh heartbeat rows in this shared test
  // process. Move beyond their lease window, then heartbeat only this consumer.
  const now = Date.now() + 10 * 60_000;

  heartbeatRuntimeEventConsumer(consumerId, first.seq, now);
  const guarded = pruneRuntimeEvents({ maxEvents: 2, now });
  expect(guarded.retainedForConsumer).toBe(first.seq);
  expect(
    listRuntimeEventsAfter(first.seq).filter((event) => event.topicId === topicId),
  ).toHaveLength(4);

  heartbeatRuntimeEventConsumer(consumerId, last.seq, now + 1);
  const released = pruneRuntimeEvents({ maxEvents: 2, now: now + 1 });
  expect(released.cutoff).toBeGreaterThan(first.seq);
  expect(listRuntimeEventsAfter(0).filter((event) => event.topicId === topicId)).toHaveLength(2);
});
