import { describe, expect, test } from "bun:test";
import { type RuntimeBusEvent, runtimeBus, SqliteRuntimeBus, setRuntimeBus } from "#bus";
import { claimDeliveryAck, prepareDeliveryAck, resolveDeliveryAck } from "#runtime/delivery-ack";
import { listRecentRuntimeEventsForTopic } from "#storage/runtime-events";

async function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(20);
    }
  }
}

describe("SQLite runtime bus", () => {
  test("carries delivery claims and results between separate bus instances", async () => {
    const original = runtimeBus();
    const waiterBus = new SqliteRuntimeBus({
      sourceId: `ack-waiter-${crypto.randomUUID()}`,
      pollIntervalMs: 25,
    });
    const adapterBus = new SqliteRuntimeBus({
      sourceId: `ack-adapter-${crypto.randomUUID()}`,
      pollIntervalMs: 25,
    });
    const topicId = `ack-topic-${crypto.randomUUID()}`;
    const messageId = crypto.randomUUID();

    try {
      setRuntimeBus(waiterBus);
      const waiter = prepareDeliveryAck(messageId, 250, 1_000);
      setRuntimeBus(adapterBus);
      claimDeliveryAck(topicId, messageId);
      resolveDeliveryAck(topicId, messageId, { ok: true });
      expect(await waiter.promise).toEqual({ ok: true });
    } finally {
      setRuntimeBus(original);
    }
  });

  test("fails a claimed delivery that never settles", async () => {
    const topicId = `ack-timeout-${crypto.randomUUID()}`;
    const messageId = crypto.randomUUID();
    const waiter = prepareDeliveryAck(messageId, 50, 20);
    claimDeliveryAck(topicId, messageId);
    expect(await waiter.promise).toEqual({
      ok: false,
      error: "channel delivery confirmation timed out",
    });
  });

  test("delivers local events immediately and peer events through the durable log", async () => {
    const left = new SqliteRuntimeBus({
      sourceId: `left-${crypto.randomUUID()}`,
      pollIntervalMs: 25,
    });
    const right = new SqliteRuntimeBus({
      sourceId: `right-${crypto.randomUUID()}`,
      pollIntervalMs: 25,
    });
    const leftEvents: RuntimeBusEvent[] = [];
    const rightEvents: RuntimeBusEvent[] = [];
    const stopLeft = left.subscribe((event) => leftEvents.push(event));
    const stopRight = right.subscribe((event) => rightEvents.push(event));

    try {
      left.broadcastTopicUpdated("topic-left");
      right.broadcastTopicUpdated("topic-right");

      expect(leftEvents.map((event) => event.topicId)).toContain("topic-left");
      expect(rightEvents.map((event) => event.topicId)).toContain("topic-right");
      await eventually(() => {
        expect(leftEvents.map((event) => event.topicId)).toContain("topic-right");
        expect(rightEvents.map((event) => event.topicId)).toContain("topic-left");
      });
      expect(leftEvents.filter((event) => event.topicId === "topic-left")).toHaveLength(1);
      expect(rightEvents.filter((event) => event.topicId === "topic-right")).toHaveLength(1);
    } finally {
      stopLeft();
      stopRight();
    }
  });

  test("does not skip a peer row committed before a local row", async () => {
    const sourceA = new SqliteRuntimeBus({
      sourceId: `a-${crypto.randomUUID()}`,
      pollIntervalMs: 25,
    });
    const sourceB = new SqliteRuntimeBus({
      sourceId: `b-${crypto.randomUUID()}`,
      pollIntervalMs: 25,
    });
    const received: string[] = [];

    sourceA.broadcastTopicUpdated("peer-first");
    sourceB.broadcastTopicUpdated("local-second");
    const stop = sourceB.subscribe((event) => received.push(event.topicId));
    try {
      await eventually(() => expect(received).toContain("peer-first"));
    } finally {
      stop();
    }
  });

  test("hydrates recent topic activity in commit order", () => {
    const topicId = `hydrate-${crypto.randomUUID()}`;
    const bus = new SqliteRuntimeBus({ sourceId: `hydrate-source-${crypto.randomUUID()}` });
    bus.broadcastAiActive(topicId, "query");
    bus.broadcastToolCall(topicId, "query", "Bash", undefined, "Bash(test)", "tool");
    bus.broadcastToolOutput(topicId, "query", "tool", "ok");

    expect(
      listRecentRuntimeEventsForTopic(topicId).map((event) =>
        String((event.payload as { kind?: unknown }).kind),
      ),
    ).toEqual(["ai_active", "tool_call", "tool_output"]);
  });
});
