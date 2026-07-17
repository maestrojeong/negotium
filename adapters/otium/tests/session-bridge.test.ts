import { afterEach, describe, expect, test } from "bun:test";
import {
  failInterruptedRemoteAskCallbacks,
  registerAskCallback,
  registerPeerSessionBridge,
  resolveAskCallback,
} from "@negotium/core";
import { configureOtiumCentral } from "@/central";
import {
  acceptRemoteAskReply,
  acceptRemoteAskReplyResult,
  flushPeerReplyOutbox,
  otiumPeerSessionBridge,
} from "@/session-bridge";
import { deleteRemoteAsk, getRemoteAsk, listPeerReplyOutbox } from "@/store";
import { startFakeCentral } from "./helpers";

const running: Array<{ stop: () => void }> = [];

afterEach(() => {
  configureOtiumCentral(null);
  while (running.length > 0) running.pop()?.stop();
});

describe("otium peer session bridge routing", () => {
  test("a worker refuses to forward user calls directly to another worker", async () => {
    const central = startFakeCentral();
    running.push(central);
    central.addPeerNode({
      cellId: "cell_other_worker",
      nodeName: "other-worker",
      isPrimary: false,
      baseUrl: "http://127.0.0.1:1",
      self: false,
    });
    configureOtiumCentral(central.join);

    const result = await otiumPeerSessionBridge.forward({
      action: "tell",
      toNode: "other-worker",
      toTopic: "target",
      userId: "user-1",
      fromKey: "caller",
      message: "secret",
      requestId: "tell-worker-worker",
      sourceQueryId: "host-query",
    });

    expect(result).toEqual({
      ok: false,
      error: "worker peer calls must target the primary hub",
    });
  });

  test("a worker returns a remote ask reply through the canonical hub callback", async () => {
    const callbacks: Array<Record<string, unknown>> = [];
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/peer/capabilities") {
          return Response.json({ ok: true, features: { remoteAsk: true } });
        }
        if (url.pathname === "/api/v1/peer/ask") return Response.json({ ok: true });
        if (url.pathname === "/api/v1/peer/ask-callback") {
          callbacks.push((await req.json()) as Record<string, unknown>);
          return Response.json({ ok: true });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    });
    running.push({ stop: () => hub.stop(true) });

    const central = startFakeCentral();
    running.push(central);
    central.addPeerNode({
      cellId: "cell_named_hub",
      nodeName: "hub",
      isPrimary: true,
      baseUrl: `http://127.0.0.1:${hub.port}`,
      self: false,
    });
    configureOtiumCentral(central.join);

    const requestId = "ask-canonical-callback";
    expect(
      await otiumPeerSessionBridge.forward({
        action: "ask",
        toNode: "hub",
        toTopic: "target",
        userId: "user-1",
        fromKey: "caller",
        fromTopicId: "worker-mirror-topic",
        message: "question",
        requestId,
        sourceQueryId: "host-query-1",
      }),
    ).toEqual({ ok: true });
    expect(getRemoteAsk(requestId)).toMatchObject({
      request_id: requestId,
      expected_cell_id: "cell_named_hub",
      source_query_id: "host-query-1",
    });

    expect(
      await acceptRemoteAskReply({
        fromCellId: "cell_named_hub",
        requestId,
        userId: "user-1",
        fromLabel: "hub/target",
        replyText: "answer",
        kind: "reply",
      }),
    ).toBe(true);
    expect(callbacks).toEqual([
      {
        v: 1,
        requestId,
        sourceQueryId: "host-query-1",
        userId: "user-1",
        fromLabel: "hub/target",
        replyText: "answer",
        kind: "reply",
      },
    ]);
    expect(getRemoteAsk(requestId)).toBeNull();
  });

  test("a failed canonical callback keeps durable routing state for retry", async () => {
    let failCallback = true;
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/v1/peer/capabilities") {
          return Response.json({ ok: true, features: { remoteAsk: true } });
        }
        if (path === "/api/v1/peer/ask") return Response.json({ ok: true });
        if (path === "/api/v1/peer/ask-callback") {
          if (failCallback) return Response.json({ ok: false, error: "retry" }, { status: 503 });
          return Response.json({ ok: true });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    });
    running.push({ stop: () => hub.stop(true) });
    const central = startFakeCentral();
    running.push(central);
    central.addPeerNode({
      cellId: "cell_retry_hub",
      nodeName: "retry-hub",
      isPrimary: true,
      baseUrl: `http://127.0.0.1:${hub.port}`,
      self: false,
    });
    configureOtiumCentral(central.join);

    const requestId = `ask-retry-${crypto.randomUUID()}`;
    expect(
      await otiumPeerSessionBridge.forward({
        action: "ask",
        toNode: "retry-hub",
        toTopic: "target",
        userId: "user-1",
        fromKey: "caller",
        fromTopicId: "worker-mirror-topic",
        message: "question",
        requestId,
        sourceQueryId: "host-query-retry",
      }),
    ).toEqual({ ok: true });

    const reply = {
      fromCellId: "cell_retry_hub",
      requestId,
      userId: "user-1",
      fromLabel: "retry-hub/target",
      replyText: "answer",
      kind: "reply" as const,
    };
    expect(await acceptRemoteAskReplyResult(reply)).toBe("retry");
    expect(getRemoteAsk(requestId)).not.toBeNull();
    failCallback = false;
    expect(await acceptRemoteAskReply(reply)).toBe(true);
    expect(getRemoteAsk(requestId)).toBeNull();
  });

  test("an ambiguous ask response preserves the route for a late reply", async () => {
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/v1/peer/capabilities") {
          return Response.json({ ok: true, features: { remoteAsk: true } });
        }
        if (path === "/api/v1/peer/ask") {
          return Response.json({ ok: false, error: "response lost after accept" }, { status: 503 });
        }
        return Response.json({ ok: false }, { status: 404 });
      },
    });
    running.push({ stop: () => hub.stop(true) });
    const central = startFakeCentral();
    running.push(central);
    central.addPeerNode({
      cellId: "cell_uncertain_hub",
      nodeName: "uncertain-hub",
      isPrimary: true,
      baseUrl: `http://127.0.0.1:${hub.port}`,
      self: false,
    });
    configureOtiumCentral(central.join);
    const requestId = `ask-uncertain-${crypto.randomUUID()}`;

    try {
      expect(
        await otiumPeerSessionBridge.forward({
          action: "ask",
          toNode: "uncertain-hub",
          toTopic: "target",
          userId: "user-1",
          fromKey: "caller",
          fromTopicId: "worker-mirror-topic",
          message: "question",
          requestId,
          sourceQueryId: "host-query-uncertain",
        }),
      ).toEqual({ ok: true });
      expect(getRemoteAsk(requestId)).not.toBeNull();
    } finally {
      deleteRemoteAsk(requestId);
    }
  });

  test("an ambiguous tell retries with the same id before reporting acceptance", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname !== "/api/v1/peer/tell") {
          return Response.json({ ok: false }, { status: 404 });
        }
        requests.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: false, error: "response lost" }, { status: 503 });
      },
    });
    running.push({ stop: () => hub.stop(true) });
    const central = startFakeCentral();
    running.push(central);
    central.addPeerNode({
      cellId: "cell_uncertain_tell_hub",
      nodeName: "uncertain-tell-hub",
      isPrimary: true,
      baseUrl: `http://127.0.0.1:${hub.port}`,
      self: false,
    });
    configureOtiumCentral(central.join);
    const requestId = `tell-uncertain-${crypto.randomUUID()}`;

    expect(
      await otiumPeerSessionBridge.forward({
        action: "tell",
        toNode: "uncertain-tell-hub",
        toTopic: "target",
        userId: "user-1",
        message: "notice",
        requestId,
      }),
    ).toEqual({ ok: true });
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.requestId))).toEqual(new Set([requestId]));
  });

  test("a failed outbound peer reply stays durable and is retried", async () => {
    let failReply = true;
    const replies: Array<Record<string, unknown>> = [];
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname !== "/api/v1/peer/reply") {
          return Response.json({ ok: false }, { status: 404 });
        }
        replies.push((await req.json()) as Record<string, unknown>);
        if (failReply) return Response.json({ ok: false, error: "retry" }, { status: 503 });
        return Response.json({ ok: true });
      },
    });
    running.push({ stop: () => hub.stop(true) });
    const central = startFakeCentral();
    running.push(central);
    central.addPeerNode({
      cellId: "cell_reply_hub",
      nodeName: "reply-hub",
      isPrimary: true,
      baseUrl: `http://127.0.0.1:${hub.port}`,
      self: false,
    });
    configureOtiumCentral(central.join);
    const requestId = `reply-outbox-${crypto.randomUUID()}`;

    expect(
      await otiumPeerSessionBridge.reply(
        {
          nodeName: "reply-hub",
          nodeCellId: "cell_reply_hub",
          topicId: "remote-caller",
          userId: "user-1",
          requestId,
        },
        "target",
        "answer",
        "reply",
      ),
    ).toBe(true);
    expect(listPeerReplyOutbox().some((row) => row.request_id === requestId)).toBe(true);

    failReply = false;
    await flushPeerReplyOutbox();
    expect(listPeerReplyOutbox().some((row) => row.request_id === requestId)).toBe(false);
    expect(replies).toHaveLength(2);
  });

  test("an inbound remote ask interrupted by restart is failed durably", async () => {
    const replies: Array<Record<string, unknown>> = [];
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname !== "/api/v1/peer/reply") {
          return Response.json({ ok: false }, { status: 404 });
        }
        replies.push((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true });
      },
    });
    running.push({ stop: () => hub.stop(true) });
    const central = startFakeCentral();
    running.push(central);
    central.addPeerNode({
      cellId: "cell_restart_hub",
      nodeName: "restart-hub",
      isPrimary: true,
      baseUrl: `http://127.0.0.1:${hub.port}`,
      self: false,
    });
    configureOtiumCentral(central.join);

    const requestId = `ask-restart-${crypto.randomUUID()}`;
    const targetQueryId = `target-${crypto.randomUUID()}`;
    const unregister = registerPeerSessionBridge(otiumPeerSessionBridge);
    running.push({ stop: unregister });
    registerAskCallback({
      requestId,
      targetQueryId,
      callerTopicId: "remote-topic",
      callerUserId: "user-1",
      createdAt: Date.now(),
      remoteReply: {
        nodeName: "restart-hub",
        nodeCellId: "cell_restart_hub",
        topicId: "remote-topic",
        userId: "user-1",
        requestId,
      },
    });

    expect(await failInterruptedRemoteAskCallbacks()).toBe(1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ requestId, kind: "error" });
    resolveAskCallback(targetQueryId);
  });
});
