import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  REMOTE_SESSION_HUB_BASE_PATH,
  type RemoteSessionHubFetch,
  setRemoteSessionHubFetch,
} from "#mcp/session-comm/hub-remote-session";
import {
  deliverPeerReply,
  isHubRemoteReplyRoute,
  parseHubRemoteReplyRoute,
} from "#mcp/session-comm/peer-forward";
import {
  failInterruptedRemoteAskCallbacks,
  registerAskCallback,
  resolveAskCallback,
} from "#runtime/ask-callbacks";
import {
  flushRemoteSessionReplyOutbox,
  runRemoteSessionMaintenance,
  setRemoteSessionRetryRandom,
} from "#runtime/remote-session-reply-outbox";
import { db } from "#storage/forum-db";
import {
  claimRemoteSessionInbox,
  completeRemoteSessionInboxClaim,
  deleteRemoteSessionReplyOutbox,
  getRemoteSessionAsk,
  getRemoteSessionInboxClaim,
  listRemoteSessionReplyOutbox,
  purgeExpiredRemoteSessionReplyOutbox,
  purgeRemoteSessionInboxClaims,
  purgeStaleRemoteSessionAsks,
  REMOTE_SESSION_INBOX_CLAIM_LEASE_MS,
  REMOTE_SESSION_INBOX_CLAIM_TTL_MS,
  REMOTE_SESSION_REPLY_OUTBOX_TTL_MS,
  recordRemoteSessionAsk,
  releaseRemoteSessionInboxClaim,
  remoteSessionPayloadHash,
  remoteSessionRetryDelayMs,
  takeRemoteSessionAsk,
  upsertRemoteSessionReplyOutbox,
} from "#storage/remote-session";

type HubCall = { url: string; init: RequestInit };

function stubHub(respond: (call: HubCall) => Response | Promise<Response> | never): {
  calls: HubCall[];
} {
  const calls: HubCall[] = [];
  const stub: RemoteSessionHubFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  setRemoteSessionHubFetch(stub);
  return { calls };
}

afterEach(() => {
  setRemoteSessionHubFetch(null);
  setRemoteSessionRetryRandom(null);
});

describe("remote_session_inbox_claims", () => {
  test("processing → completed: only a completed claim replays; a live lease is in_progress; an expired one is taken over", () => {
    const requestId = `claim-${randomUUID()}`;
    const payloadHash = remoteSessionPayloadHash({ kind: "tell", message: "hi" });
    const args = { requestId, kind: "tell" as const, topicId: "t-1", payloadHash };
    expect(claimRemoteSessionInbox(args)).toBe("claimed");
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("processing");
    // Same payload while the lease is live: not a replay.
    expect(claimRemoteSessionInbox(args)).toBe("in_progress");
    expect(
      claimRemoteSessionInbox({ ...args, payloadHash: remoteSessionPayloadHash({ x: 1 }) }),
    ).toBe("conflict");
    expect(claimRemoteSessionInbox({ ...args, topicId: "t-2" })).toBe("conflict");
    expect(claimRemoteSessionInbox({ ...args, kind: "ask" })).toBe("conflict");
    // The lease ran out (the holder died): the next delivery takes over.
    expect(
      claimRemoteSessionInbox({
        ...args,
        now: Date.now() + REMOTE_SESSION_INBOX_CLAIM_LEASE_MS + 1,
      }),
    ).toBe("claimed");
    // A fresh process may force a takeover regardless of the lease.
    expect(claimRemoteSessionInbox({ ...args, force: true })).toBe("claimed");
    expect(completeRemoteSessionInboxClaim(requestId)).toBe(true);
    expect(completeRemoteSessionInboxClaim(requestId)).toBe(false);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    expect(claimRemoteSessionInbox(args)).toBe("replay");
    expect(claimRemoteSessionInbox({ ...args, force: true })).toBe("replay");
    expect(releaseRemoteSessionInboxClaim(requestId)).toBe(true);
    expect(releaseRemoteSessionInboxClaim(requestId)).toBe(false);
    expect(claimRemoteSessionInbox(args)).toBe("claimed");
    releaseRemoteSessionInboxClaim(requestId);
  });

  test("a processing claim keeps the delivery payload until completed", () => {
    const requestId = `claim-payload-${randomUUID()}`;
    const payload = { kind: "ask-reply", requestId, replyText: "42" };
    claimRemoteSessionInbox({
      requestId,
      kind: "ask-reply",
      topicId: "t",
      payloadHash: remoteSessionPayloadHash(payload),
      payload,
    });
    expect(getRemoteSessionInboxClaim(requestId)?.payload).toEqual(payload);
    completeRemoteSessionInboxClaim(requestId);
    expect(getRemoteSessionInboxClaim(requestId)?.payload).toBeNull();
    releaseRemoteSessionInboxClaim(requestId);
  });

  test("forgets claims older than the TTL", () => {
    const requestId = `claim-old-${randomUUID()}`;
    const now = Date.now();
    claimRemoteSessionInbox({
      requestId,
      kind: "abort",
      topicId: "t",
      payloadHash: "h",
      now: now - REMOTE_SESSION_INBOX_CLAIM_TTL_MS - 1,
    });
    expect(purgeRemoteSessionInboxClaims(now)).toBeGreaterThanOrEqual(1);
    expect(releaseRemoteSessionInboxClaim(requestId)).toBe(false);
  });
});

describe("remote_session_asks", () => {
  test("records the caller once and hands it back exactly once", () => {
    const requestId = `ask-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId,
      callerTopicId: "caller",
      userId: "local",
      fromKey: "agent:Caller",
      toKey: "worker/Target",
      callerThreadRootId: "thread-1",
    });
    expect(getRemoteSessionAsk(requestId)).toMatchObject({
      requestId,
      callerTopicId: "caller",
      userId: "local",
      fromKey: "agent:Caller",
      toKey: "worker/Target",
      callerThreadRootId: "thread-1",
    });
    expect(takeRemoteSessionAsk(requestId)?.requestId).toBe(requestId);
    expect(takeRemoteSessionAsk(requestId)).toBeNull();
    expect(getRemoteSessionAsk(requestId)).toBeNull();
  });

  test("drops rows older than the pending-ask TTL", () => {
    const requestId = `ask-old-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId,
      callerTopicId: "caller",
      userId: "local",
      fromKey: "a",
      toKey: "b",
      createdAt: Date.now() - REMOTE_SESSION_REPLY_OUTBOX_TTL_MS - 1,
    });
    expect(purgeStaleRemoteSessionAsks()).toBeGreaterThanOrEqual(1);
    expect(getRemoteSessionAsk(requestId)).toBeNull();
  });

  test("the periodic maintenance pass (injectable clock) purges old claims and stale asks", async () => {
    const claimId = `mt-claim-${randomUUID()}`;
    const askId = `mt-ask-${randomUUID()}`;
    const base = Date.now();
    claimRemoteSessionInbox({
      requestId: claimId,
      kind: "abort",
      topicId: "t",
      payloadHash: "h",
      now: base,
    });
    completeRemoteSessionInboxClaim(claimId, base);
    recordRemoteSessionAsk({
      requestId: askId,
      callerTopicId: "caller",
      userId: "local",
      fromKey: "a",
      toKey: "b",
      createdAt: base,
    });
    stubHub(() => Response.json({ ok: true, v: 1, replayed: false }));
    // Fresh: nothing goes.
    await runRemoteSessionMaintenance(base + 1_000);
    expect(getRemoteSessionInboxClaim(claimId)).not.toBeNull();
    expect(getRemoteSessionAsk(askId)).not.toBeNull();
    // Past the ask TTL but not the claim TTL.
    await runRemoteSessionMaintenance(base + REMOTE_SESSION_REPLY_OUTBOX_TTL_MS + 1);
    expect(getRemoteSessionInboxClaim(claimId)).not.toBeNull();
    expect(getRemoteSessionAsk(askId)).toBeNull();
    // Past the claim TTL.
    await runRemoteSessionMaintenance(base + REMOTE_SESSION_INBOX_CLAIM_TTL_MS + 1);
    expect(getRemoteSessionInboxClaim(claimId)).toBeNull();
  });
});

describe("reply retry backoff", () => {
  test("5, 10, 20, 30 s cap with ±20 % jitter, deterministic under an injected random", () => {
    const low = () => 0;
    const mid = () => 0.5;
    const high = () => 1;
    expect([1, 2, 3, 4, 5, 9].map((n) => remoteSessionRetryDelayMs(n, mid))).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ]);
    expect(remoteSessionRetryDelayMs(1, low)).toBe(4_000);
    expect(remoteSessionRetryDelayMs(1, high)).toBe(6_000);
    expect(remoteSessionRetryDelayMs(4, high)).toBe(36_000);
  });
});

describe("hub reply route", () => {
  const route = {
    via: "hub" as const,
    hubUrl: "https://hub.example",
    token: "rsr1.cGF5bG9hZA.c2ln",
    nodeName: "hub",
    topicId: "caller-topic",
    requestId: `reply-${randomUUID()}`,
  };

  test("is recognised structurally and rejected when incomplete", () => {
    expect(isHubRemoteReplyRoute(route)).toBe(true);
    expect(
      isHubRemoteReplyRoute({
        nodeName: "n",
        nodeCellId: "c",
        topicId: "t",
        userId: "u",
        requestId: "r",
      }),
    ).toBe(false);
    expect(parseHubRemoteReplyRoute(route)).toEqual(route);
    expect(parseHubRemoteReplyRoute({ ...route, token: "not-a-reply-token" })).toBeNull();
    expect(parseHubRemoteReplyRoute({ ...route, via: "peer" })).toBeNull();
    expect(parseHubRemoteReplyRoute({ ...route, requestId: "" })).toBeNull();
    expect(parseHubRemoteReplyRoute(null)).toBeNull();
  });

  test("the hub URL obeys the grant's rule and the token its shape, so a bearer is never steered elsewhere", () => {
    // Accepted: https anywhere, http on loopback only; canonical form stored.
    expect(parseHubRemoteReplyRoute({ ...route, hubUrl: "http://127.0.0.1:3100/" })?.hubUrl).toBe(
      "http://127.0.0.1:3100",
    );
    expect(
      parseHubRemoteReplyRoute({ ...route, hubUrl: "https://hub.example/base/" })?.hubUrl,
    ).toBe("https://hub.example/base");
    for (const hubUrl of [
      "http://hub.example",
      "http://10.0.0.5:3100",
      "http://[::2]:3100",
      "https://user:pw@hub.example",
      "https://hub.example/?x=1",
      "https://hub.example/#frag",
      "ftp://hub.example",
      "not a url",
      `https://${"h".repeat(600)}.example`,
    ]) {
      expect(parseHubRemoteReplyRoute({ ...route, hubUrl })).toBeNull();
    }
    expect(parseHubRemoteReplyRoute({ ...route, token: "rsr1.onlyone" })).toBeNull();
    expect(parseHubRemoteReplyRoute({ ...route, token: "rsr1.a b.c" })).toBeNull();
    expect(
      parseHubRemoteReplyRoute({ ...route, token: `rsr1.${"a".repeat(2100)}.sig` }),
    ).toBeNull();
    expect(parseHubRemoteReplyRoute({ ...route, requestId: "r".repeat(201) })).toBeNull();
    expect(parseHubRemoteReplyRoute({ ...route, nodeName: "" })).toBeNull();
  });

  test("every bearer POST refuses redirects and requires the exact v1 envelope; a malformed 2xx keeps the outbox row", async () => {
    let body: () => Response = () => new Response("<html>ok</html>", { status: 200 });
    const hub = stubHub(() => body());
    const requestId = `reply-env-${randomUUID()}`;
    expect(await deliverPeerReply({ ...route, requestId }, "w/T", "x", "reply")).toBe(true);
    expect(hub.calls[0]!.init.redirect).toBe("error");
    const kept = () =>
      listRemoteSessionReplyOutbox({ due: false }).find((e) => e.requestId === requestId);
    expect(kept()).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("unexpected body"),
    });
    // Wrong `v`, missing `ok`, `ok:false` on a 200 — all protocol failures.
    for (const answer of [
      { ok: true, v: 2, replayed: false },
      { v: 1, replayed: false },
      { ok: false, v: 1, replayed: false },
      { ok: true, v: 1 },
    ]) {
      body = () => Response.json(answer);
      await flushRemoteSessionReplyOutbox(kept()!.nextAttemptAt + 1);
      expect(kept()).toBeDefined();
    }
    // A 30x is never followed: the fetch seam sees `redirect: "error"` and a
    // real fetch would throw, which the outbox treats as a transport failure.
    body = () => {
      throw new TypeError("unexpected redirect");
    };
    await flushRemoteSessionReplyOutbox(kept()!.nextAttemptAt + 1);
    expect(kept()).toMatchObject({ lastError: expect.stringContaining("unexpected redirect") });
    body = () => Response.json({ ok: true, v: 1, replayed: false });
    await flushRemoteSessionReplyOutbox(kept()!.nextAttemptAt + 1);
    expect(kept()).toBeUndefined();
  });

  test("the outbox backs off 5/10/20/30 s (jittered, deterministic here) instead of a flat 5 s", async () => {
    setRemoteSessionRetryRandom(() => 0.5);
    stubHub(() => {
      throw new TypeError("fetch failed");
    });
    const requestId = `reply-backoff-${randomUUID()}`;
    const t0 = Date.now();
    await deliverPeerReply({ ...route, requestId }, "w/T", "x", "reply");
    const row = () =>
      listRemoteSessionReplyOutbox({ due: false }).find((e) => e.requestId === requestId)!;
    const delays: number[] = [];
    let at = t0;
    for (let i = 0; i < 5; i += 1) {
      at = row().nextAttemptAt;
      await flushRemoteSessionReplyOutbox(at);
      delays.push(row().nextAttemptAt - at);
    }
    expect(row().attempts).toBe(6);
    expect(delays).toEqual([10_000, 20_000, 30_000, 30_000, 30_000]);
    expect(row().nextAttemptAt - t0).toBeGreaterThan(0);
    deleteRemoteSessionReplyOutbox(requestId);
  });

  test("deliverPeerReply posts the answer to the hub with the reply token and clears the outbox", async () => {
    const hub = stubHub(() => Response.json({ ok: true, v: 1, replayed: false }));
    expect(await deliverPeerReply(route, "worker/Target", "the answer", "reply")).toBe(true);
    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0]!.url).toBe(`${route.hubUrl}${REMOTE_SESSION_HUB_BASE_PATH}/reply`);
    const headers = new Headers(hub.calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${route.token}`);
    expect(JSON.parse(String(hub.calls[0]!.init.body))).toEqual({
      v: 1,
      requestId: route.requestId,
      kind: "reply",
      replyText: "the answer",
      fromLabel: "worker/Target",
    });
    expect(
      listRemoteSessionReplyOutbox({ due: false }).some((e) => e.requestId === route.requestId),
    ).toBe(false);
  });

  test("a hub that is down keeps the answer in the outbox and retries later; a final refusal drops it", async () => {
    const requestId = `reply-retry-${randomUUID()}`;
    let mode: "down" | "up" | "expired" = "down";
    const hub = stubHub(() => {
      if (mode === "down") throw new TypeError("fetch failed");
      if (mode === "expired")
        return Response.json({ ok: false, error: "reply token expired" }, { status: 401 });
      return Response.json({ ok: true, v: 1, replayed: true });
    });
    expect(await deliverPeerReply({ ...route, requestId }, "worker/Target", "late", "reply")).toBe(
      true,
    );
    const deferred = listRemoteSessionReplyOutbox({ due: false }).find(
      (e) => e.requestId === requestId,
    );
    expect(deferred).toMatchObject({
      attempts: 1,
      lastError: expect.stringContaining("hub unreachable"),
    });
    expect(deferred!.nextAttemptAt).toBeGreaterThan(Date.now());
    // Not due yet: a flush now does not hit the hub again.
    await flushRemoteSessionReplyOutbox();
    expect(hub.calls).toHaveLength(1);
    // Due: the retry carries the same request id and token, and a hub that
    // already has the answer (replayed) settles it just the same.
    mode = "up";
    await flushRemoteSessionReplyOutbox(deferred!.nextAttemptAt + 1);
    expect(hub.calls).toHaveLength(2);
    expect(JSON.parse(String(hub.calls[1]!.init.body)).requestId).toBe(requestId);
    expect(
      listRemoteSessionReplyOutbox({ due: false }).some((e) => e.requestId === requestId),
    ).toBe(false);

    // A 401/404/4xx verdict is final: no retry can change it, so the row goes.
    mode = "expired";
    const finalId = `reply-final-${randomUUID()}`;
    expect(await deliverPeerReply({ ...route, requestId: finalId }, "w/T", "x", "error")).toBe(
      true,
    );
    expect(listRemoteSessionReplyOutbox({ due: false }).some((e) => e.requestId === finalId)).toBe(
      false,
    );
  });

  test("answers older than the pending-ask TTL are purged instead of retried forever", () => {
    const requestId = `reply-old-${randomUUID()}`;
    upsertRemoteSessionReplyOutbox({
      requestId,
      hubUrl: route.hubUrl,
      token: route.token,
      kind: "reply",
      replyText: "stale",
      fromLabel: "w/T",
      createdAt: Date.now() - REMOTE_SESSION_REPLY_OUTBOX_TTL_MS - 1,
    });
    expect(purgeExpiredRemoteSessionReplyOutbox().map((e) => e.requestId)).toContain(requestId);
    expect(deleteRemoteSessionReplyOutbox(requestId)).toBe(false);
  });

  test("resolving a hub-routed callback keeps its durable row until the outbox has the answer (one transaction)", async () => {
    const requestId = `cb-tx-${randomUUID()}`;
    const targetQueryId = `q-tx-${randomUUID()}`;
    stubHub(() => {
      throw new TypeError("fetch failed");
    });
    registerAskCallback({
      requestId,
      targetQueryId,
      callerTopicId: route.topicId,
      callerUserId: "local",
      createdAt: Date.now(),
      remoteReply: { ...route, requestId },
      sourceLabel: "Target",
    });
    const rowCount = () =>
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM remote_ask_callbacks WHERE request_id = ?",
        )
        .get(requestId)?.n;
    const pending = resolveAskCallback(targetQueryId);
    expect(pending?.requestId).toBe(requestId);
    // "Crash between resolve and enqueue": the durable row is still there, so
    // the startup pass would still fail the ask explicitly.
    expect(rowCount()).toBe(1);
    expect(await deliverPeerReply(pending!.remoteReply!, "Target", "the answer", "reply")).toBe(
      true,
    );
    // Now the outbox holds the answer and the callback row is gone — atomically.
    expect(rowCount()).toBe(0);
    expect(
      listRemoteSessionReplyOutbox({ due: false }).find((e) => e.requestId === requestId),
    ).toMatchObject({ replyText: "the answer", kind: "reply" });
    deleteRemoteSessionReplyOutbox(requestId);
  });

  test("a hub-routed ask callback survives a restart and is failed through the outbox", async () => {
    const requestId = `cb-${randomUUID()}`;
    const targetQueryId = `q-${randomUUID()}`;
    const hub = stubHub(() => Response.json({ ok: true, v: 1, replayed: false }));
    registerAskCallback({
      requestId,
      targetQueryId,
      callerTopicId: route.topicId,
      callerUserId: "local",
      createdAt: Date.now(),
      remoteReply: { ...route, requestId },
      sourceLabel: "Target",
    });
    const row = db
      .query<{ route_json: string | null; node_cell_id: string }, [string]>(
        "SELECT route_json, node_cell_id FROM remote_ask_callbacks WHERE target_query_id = ?",
      )
      .get(targetQueryId);
    expect(row?.node_cell_id).toBe("");
    expect(parseHubRemoteReplyRoute(JSON.parse(row?.route_json ?? "null"))).toEqual({
      ...route,
      requestId,
    });
    // The node's own startup pass covers hub routes without any adapter.
    expect(await failInterruptedRemoteAskCallbacks({ routes: "hub" })).toBeGreaterThanOrEqual(1);
    const failed = hub.calls
      .map((c) => JSON.parse(String(c.init.body)))
      .find((b) => b.requestId === requestId);
    expect(failed).toMatchObject({ kind: "error", requestId });
    // The in-memory registration is untouched (this is a restart path); clean it.
    expect(resolveAskCallback(targetQueryId)?.requestId).toBe(requestId);
  });
});
