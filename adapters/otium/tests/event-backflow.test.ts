import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runtimeBus } from "@negotium/core";
import { configureOtiumCentral, type PeerNode } from "@/central";
import {
  createTurnForwarder,
  getActiveForwarder,
  hubEventSender,
  registerTurnForwarder,
  type SendEventResult,
  startEventBackflow,
  stopEventBackflow,
  translateBusEvent,
} from "@/event-backflow";
import {
  type FakeCentral,
  type FakeHub,
  HUB_CELL_ID,
  MINTED_TOKEN,
  startFakeCentral,
  startFakeHub,
  waitFor,
} from "./helpers";

let central: FakeCentral;
let hub: FakeHub;

beforeAll(() => {
  central = startFakeCentral();
  hub = startFakeHub();
  central.setHubBaseUrl(hub.url);
  configureOtiumCentral(central.join);
});

afterAll(() => {
  configureOtiumCentral(null);
  hub.stop();
  central.stop();
});

afterEach(() => {
  stopEventBackflow();
});

function recordingSender(behavior?: (seq: number, attempt: number) => SendEventResult) {
  const sent: Array<{ seq: number; event: Record<string, unknown> }> = [];
  const attempts = new Map<number, number>();
  return {
    sent,
    attempts,
    send: async (payload: { seq: number; event: Record<string, unknown> }) => {
      const attempt = (attempts.get(payload.seq) ?? 0) + 1;
      attempts.set(payload.seq, attempt);
      const result = behavior?.(payload.seq, attempt) ?? ({ ok: true } as SendEventResult);
      if (result.ok) sent.push({ seq: payload.seq, event: payload.event });
      return result;
    },
  };
}

describe("translateBusEvent — golden WsServerMessage shapes", () => {
  const topicId = "peer-topic-1";

  test("message / message_updated", () => {
    const message = { id: "m1", topicId, authorId: "ai", text: "answer", queryId: "q1" };
    expect(translateBusEvent({ type: "message", topicId, payload: message })).toEqual({
      type: "message",
      topicId,
      message,
    });
    expect(
      translateBusEvent({
        type: "message-updated",
        topicId,
        payload: { messageId: "tasks-q1", patch: { text: "📋 Tasks (1/2)", editedAt: "T" } },
      }),
    ).toEqual({
      type: "message_updated",
      topicId,
      messageId: "tasks-q1",
      text: "📋 Tasks (1/2)",
      editedAt: "T",
    });
  });

  test("ai-status kinds are renamed to WS type shapes exactly", () => {
    const status = (payload: Record<string, unknown>) =>
      translateBusEvent({ type: "ai-status", topicId, payload });

    expect(status({ kind: "typing", userId: "ai" })).toEqual({
      type: "typing",
      topicId,
      userId: "ai",
    });
    expect(
      status({
        kind: "tool_call",
        queryId: "q1",
        name: "Bash",
        input: { command: "ls" },
        label: "Bash(ls)",
        toolUseId: "t1",
      }),
    ).toEqual({
      type: "tool_call",
      topicId,
      queryId: "q1",
      name: "Bash",
      input: { command: "ls" },
      label: "Bash(ls)",
      toolUseId: "t1",
    });
    expect(status({ kind: "tool_output", queryId: "q1", toolUseId: "t1", content: "ok" })).toEqual({
      type: "tool_output",
      topicId,
      queryId: "q1",
      toolUseId: "t1",
      content: "ok",
    });
    // bus.ts stores the WS-level `kind` as `statusKind` — must be restored.
    expect(
      status({
        kind: "tool_status",
        queryId: "q1",
        statusKind: "progress",
        content: "Bash running 3s",
        toolName: "Bash",
        elapsed: 3,
      }),
    ).toEqual({
      type: "tool_status",
      topicId,
      queryId: "q1",
      kind: "progress",
      content: "Bash running 3s",
      toolName: "Bash",
      elapsed: 3,
    });
    expect(status({ kind: "file_ready", queryId: "q1", path: "/tmp/a.png", source: "s" })).toEqual({
      type: "file_ready",
      topicId,
      queryId: "q1",
      path: "/tmp/a.png",
      source: "s",
    });
    // visualKind → kind rename.
    expect(
      status({
        kind: "visual",
        queryId: "q1",
        url: "/v/1",
        id: 1,
        title: null,
        visualKind: "html",
      }),
    ).toEqual({
      type: "visual",
      topicId,
      queryId: "q1",
      url: "/v/1",
      id: 1,
      title: null,
      kind: "html",
    });
    expect(
      status({
        kind: "ai_done",
        queryId: "q1",
        usage: { input: 10, output: 5 },
        agent: "claude",
        model: "sonnet",
      }),
    ).toEqual({
      type: "ai_done",
      topicId,
      queryId: "q1",
      usage: { input: 10, output: 5 },
      agent: "claude",
      model: "sonnet",
    });
    expect(status({ kind: "ai_error", queryId: "q1", error: "boom" })).toEqual({
      type: "ai_error",
      topicId,
      queryId: "q1",
      error: "boom",
    });
    expect(status({ kind: "ai_aborted", queryId: "q1", reason: "stopped" })).toEqual({
      type: "ai_aborted",
      topicId,
      queryId: "q1",
      reason: "stopped",
    });
  });

  test("non-forwarded events are dropped", () => {
    expect(
      translateBusEvent({
        type: "ai-status",
        topicId,
        payload: { kind: "ai_active", queryId: "q1" },
      }),
    ).toBeNull();
    expect(
      translateBusEvent({ type: "topic-created", topicId, payload: { id: topicId } }),
    ).toBeNull();
    expect(translateBusEvent({ type: "topic-updated", topicId, payload: null })).toBeNull();
  });
});

describe("forwarder over the live RuntimeBus", () => {
  test("assigns contiguous seq from 1, filters foreign turns, cleans up on terminal", async () => {
    const topicId = "peer-live-topic";
    const recorder = recordingSender();
    const forwarder = createTurnForwarder({
      hostNodeId: HUB_CELL_ID,
      requestId: "pt-live-1",
      localTopicId: topicId,
      sendEvent: recorder.send,
    });
    forwarder.queryId = "q-live";
    registerTurnForwarder(topicId, forwarder);
    startEventBackflow();

    const bus = runtimeBus();
    bus.broadcastTyping(topicId, "ai");
    bus.broadcastToolCall(topicId, "q-live", "Bash", { command: "ls" }, "Bash(ls)", "t1");
    // Foreign turn (superseded predecessor) — must be dropped.
    bus.broadcastToolCall(topicId, "q-OTHER", "Bash", undefined, "Bash(x)", "t2");
    // Another topic entirely — must be dropped.
    bus.broadcastToolCall("some-other-topic", "q-live", "Bash", undefined, "Bash(y)", "t3");
    bus.broadcastMessage(topicId, {
      id: "m1",
      topicId,
      authorId: "ai",
      text: "done!",
      queryId: "q-live",
      createdAt: new Date().toISOString(),
    });
    bus.broadcastDone(topicId, "q-live", { input: 1, output: 2 }, { agent: "claude", model: "m" });

    await waitFor(() => recorder.sent.length === 4);
    expect(recorder.sent.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(recorder.sent.map((e) => e.event.type)).toEqual([
      "typing",
      "tool_call",
      "message",
      "ai_done",
    ]);

    // Terminal cleans up the tap; later events are not forwarded.
    expect(getActiveForwarder(topicId)).toBeUndefined();
    bus.broadcastTyping(topicId, "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recorder.sent.length).toBe(4);
  });

  test("retries with backoff, then hard-blocks: seq N lost ⇒ N+1 never sent", async () => {
    const topicId = "peer-block-topic";
    const recorder = recordingSender(() => ({ ok: false, error: "injected" }));
    const forwarder = createTurnForwarder({
      hostNodeId: HUB_CELL_ID,
      requestId: "pt-block-1",
      localTopicId: topicId,
      sendEvent: recorder.send,
      retryBaseMs: 1,
    });
    forwarder.queryId = "q-block";
    registerTurnForwarder(topicId, forwarder);
    startEventBackflow();

    const bus = runtimeBus();
    bus.broadcastTyping(topicId, "ai"); // seq 1 — will exhaust its retry budget
    bus.broadcastDone(topicId, "q-block"); // seq 2 — must NEVER be attempted

    await forwarder.chain;
    expect(forwarder.deliveryBlocked).toBe(true);
    expect(recorder.attempts.get(1)).toBe(5);
    expect(recorder.attempts.get(2)).toBeUndefined();
    expect(recorder.sent.length).toBe(0);
  });

  test("transient failures recover within the 5-attempt budget", async () => {
    const topicId = "peer-retry-topic";
    const recorder = recordingSender((_seq, attempt) =>
      attempt < 3 ? { ok: false, error: "flaky", status: 500 } : { ok: true },
    );
    const forwarder = createTurnForwarder({
      hostNodeId: HUB_CELL_ID,
      requestId: "pt-retry-1",
      localTopicId: topicId,
      sendEvent: recorder.send,
      retryBaseMs: 1,
    });
    forwarder.queryId = "q-retry";
    registerTurnForwarder(topicId, forwarder);
    startEventBackflow();

    runtimeBus().broadcastDone(topicId, "q-retry");
    await forwarder.chain;
    expect(forwarder.deliveryBlocked).toBe(false);
    expect(recorder.attempts.get(1)).toBe(3);
    expect(recorder.sent.map((e) => e.event.type)).toEqual(["ai_done"]);
  });
});

describe("hubEventSender against a fake hub (Bun.serve port 0)", () => {
  test("POSTs {v, requestId, seq, event} with a freshly minted peer token", async () => {
    const topicId = "peer-http-topic";
    const node: PeerNode = {
      cellId: HUB_CELL_ID,
      nodeName: null,
      isPrimary: true,
      baseUrl: hub.url,
      self: false,
    };
    const forwarder = createTurnForwarder({
      hostNodeId: HUB_CELL_ID,
      requestId: "pt-http-1",
      localTopicId: topicId,
      sendEvent: hubEventSender(node),
    });
    forwarder.queryId = "q-http";
    registerTurnForwarder(topicId, forwarder);
    startEventBackflow();

    const bus = runtimeBus();
    bus.broadcastTyping(topicId, "ai");
    bus.broadcastDone(topicId, "q-http", { input: 3, output: 4 });

    await waitFor(() => hub.events.length === 2);
    expect(hub.events[0]!.auth).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(hub.events[0]!.body).toEqual({
      v: 1,
      requestId: "pt-http-1",
      seq: 1,
      event: { type: "typing", topicId, userId: "ai" },
    });
    expect(hub.events[1]!.body.seq).toBe(2);
    expect(hub.events[1]!.body.event).toEqual({
      type: "ai_done",
      topicId,
      queryId: "q-http",
      usage: { input: 3, output: 4 },
    });
  });

  test("hub 5xx responses are retried against the real HTTP path", async () => {
    const topicId = "peer-http-retry-topic";
    const node: PeerNode = {
      cellId: HUB_CELL_ID,
      nodeName: null,
      isPrimary: true,
      baseUrl: hub.url,
      self: false,
    };
    const before = hub.events.length;
    hub.failNext(2);
    const forwarder = createTurnForwarder({
      hostNodeId: HUB_CELL_ID,
      requestId: "pt-http-2",
      localTopicId: topicId,
      sendEvent: hubEventSender(node),
      retryBaseMs: 1,
    });
    forwarder.queryId = "q-http2";
    registerTurnForwarder(topicId, forwarder);
    startEventBackflow();

    runtimeBus().broadcastDone(topicId, "q-http2");
    await forwarder.chain;
    expect(forwarder.deliveryBlocked).toBe(false);
    expect(hub.events.length).toBe(before + 1);
    expect(hub.events.at(-1)!.body).toMatchObject({ requestId: "pt-http-2", seq: 1 });
  });
});
