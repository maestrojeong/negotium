/**
 * The caller side of a hub-routed ask (`ask-reply` inbox deliveries) as one
 * durable state machine: concurrent duplicates, a failing injection, and
 * crashes between the steps must all end with the answer in the caller room
 * exactly once and the hub told the truth at every point.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setRemoteSessionHubFetch } from "#mcp/session-comm/hub-remote-session";
import { interSessionQueue } from "#query/active-rooms";
import {
  deliverRemoteSessionInbox,
  REMOTE_SESSION_INBOX_IN_PROGRESS_CODE,
  recoverRemoteSessionInbox,
  remoteSessionInboxClaimHash,
  remoteSessionInboxEnvelope,
  setRemoteSessionAskReplyDeliverer,
} from "#runtime/remote-session-inbox";
import { runRemoteSessionMaintenance } from "#runtime/remote-session-reply-outbox";
import { deliverAskCallbackToCaller } from "#runtime/turn-runner";
import { listApiMessages } from "#storage/api-messages";
import { db } from "#storage/forum-db";
import {
  claimRemoteSessionInbox,
  getRemoteSessionAsk,
  getRemoteSessionInboxClaim,
  REMOTE_SESSION_INBOX_CLAIM_LEASE_MS,
  recordRemoteSessionAsk,
  releaseRemoteSessionInboxClaim,
  remoteSessionPayloadHash,
} from "#storage/remote-session";
import { registerTopic } from "#topics/create";

const PRINCIPAL = "local";

function agentCallerRoom(): { id: string; title: string; agent: "claude" } {
  const topic = registerTopic({
    title: `remote-inbox-agent-caller-${randomUUID()}`,
    userId: PRINCIPAL,
    agent: "claude",
    surface: "otium",
    surfaceScope: `ws-${randomUUID()}`,
  });
  return { id: topic.id, title: topic.title, agent: "claude" };
}

function callerRoom(): { id: string; title: string; agent: undefined } {
  const topic = registerTopic({
    title: `remote-inbox-caller-${randomUUID()}`,
    userId: PRINCIPAL,
    surface: "otium",
    surfaceScope: `ws-${randomUUID()}`,
  });
  // A human-only caller: the answer is appended as a message, which is the
  // durable caller-delivery record this state machine is built around.
  db.run(
    "UPDATE api_topics SET kind = 'channel', response_policy = 'off', agent = NULL WHERE id = ?",
    [topic.id],
  );
  return { id: topic.id, title: topic.title, agent: undefined };
}

function askFor(topic: { id: string }, requestId: string): void {
  recordRemoteSessionAsk({
    requestId,
    callerTopicId: topic.id,
    userId: PRINCIPAL,
    fromKey: "agent:Caller",
    toKey: "worker/Target",
  });
}

function replyDelivery(requestId: string) {
  return {
    kind: "ask-reply" as const,
    requestId,
    fromLabel: "worker/Target",
    replyKind: "reply" as const,
    replyText: `answer ${requestId}`,
  };
}

/** The claim the live path persists for a verified ask-reply (before a crash). */
function verifiedClaim(
  topic: { id: string },
  delivery: ReturnType<typeof replyDelivery>,
  principal: { userId?: string; actorUserId?: string | null; askUserId?: string } = {},
) {
  const userId = principal.userId ?? PRINCIPAL;
  const actorUserId = principal.actorUserId === undefined ? PRINCIPAL : principal.actorUserId;
  return {
    requestId: delivery.requestId,
    kind: "ask-reply" as const,
    topicId: topic.id,
    payloadHash: remoteSessionInboxClaimHash({ userId, actorUserId, delivery }),
    payload: remoteSessionInboxEnvelope({
      userId,
      actorUserId,
      delivery,
      askUserId: principal.askUserId ?? PRINCIPAL,
    }),
  };
}

function replies(topicId: string): number {
  return listApiMessages(topicId).page.filter((m) => m.kind === "tell").length;
}

afterEach(() => {
  setRemoteSessionAskReplyDeliverer(null);
  setRemoteSessionHubFetch(null);
});

describe("remote ask-reply inbox state machine", () => {
  test("a duplicate that meets a live processing claim is in_progress, never a replay; the first failure releases, the retry delivers once", async () => {
    const topic = callerRoom();
    const requestId = `ar-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);

    // First delivery: block inside the injection, then fail it.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    setRemoteSessionAskReplyDeliverer(async (...args) => {
      calls += 1;
      if (calls === 1) {
        await blocked;
        throw new Error("injection failed");
      }
      return deliverAskCallbackToCaller(...args);
    });
    const first = deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery });
    // Let the first claim land before the duplicates arrive.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("processing");
    // The ask row is NOT consumed while processing.
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();

    // A second, identical delivery meanwhile is serialized behind the first
    // (same process) — so it runs after the first has failed and released,
    // and therefore performs the delivery itself.
    const second = deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery });
    release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome).toEqual({
      ok: false,
      status: 500,
      error: "reply could not be delivered to the caller",
    });
    expect(secondOutcome).toEqual({ ok: true, replayed: false });
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    expect(getRemoteSessionAsk(requestId)).toBeNull();
    // Now, and only now, a retry is a replay.
    expect(await deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery })).toEqual({
      ok: true,
      replayed: true,
    });
    expect(replies(topic.id)).toBe(1);
    expect(calls).toBe(2);
  });

  test("a claim another process holds under a live lease answers 409 in_progress", async () => {
    const topic = callerRoom();
    const requestId = `ar-lease-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    // Simulate another process: the claim exists, processing, lease live.
    expect(
      claimRemoteSessionInbox({
        requestId,
        kind: "ask-reply",
        topicId: topic.id,
        payloadHash: remoteSessionPayloadHash(delivery),
        payload: delivery,
      }),
    ).toBe("claimed");
    const result = await deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery });
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: REMOTE_SESSION_INBOX_IN_PROGRESS_CODE,
    });
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    // Hand the other process's claim back so later passes do not adopt it.
    releaseRemoteSessionInboxClaim(requestId);
  });

  test("crash after the claim: the expired lease is re-run once by recovery; the hub then sees a replay", async () => {
    const topic = callerRoom();
    const requestId = `ar-crash-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    const died = Date.now() - REMOTE_SESSION_INBOX_CLAIM_LEASE_MS - 1;
    // "Killed after claim": processing claim with the payload, ask row intact,
    // nothing in the room.
    claimRemoteSessionInbox({ ...verifiedClaim(topic, delivery), now: died });
    // Before the lease runs out nothing is touched.
    expect(await recoverRemoteSessionInbox(died + 1)).toBe(0);
    expect(replies(topic.id)).toBe(0);
    // The periodic maintenance pass (injectable clock) recovers it.
    setRemoteSessionHubFetch(async () => Response.json({ ok: true, v: 1, replayed: true }));
    const pass = await runRemoteSessionMaintenance(Date.now());
    expect(pass.recovered).toBe(1);
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    expect(getRemoteSessionAsk(requestId)).toBeNull();
    // Recovery is idempotent and the hub's retry is a replay.
    await recoverRemoteSessionInbox(Date.now() + REMOTE_SESSION_INBOX_CLAIM_LEASE_MS);
    expect(replies(topic.id)).toBe(1);
    // The hub's retry carries the same asserted actor the claim was bound to.
    expect(
      await deliverRemoteSessionInbox({
        topic,
        userId: PRINCIPAL,
        actorUserId: PRINCIPAL,
        delivery,
      }),
    ).toEqual({ ok: true, replayed: true });
    expect(replies(topic.id)).toBe(1);
  });

  test("a fresh process re-runs even a live-lease claim (startup) — exactly once", async () => {
    const topic = callerRoom();
    const requestId = `ar-boot-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    claimRemoteSessionInbox(verifiedClaim(topic, delivery));
    expect(await recoverRemoteSessionInbox(Date.now(), { includeLive: true })).toBe(1);
    expect(replies(topic.id)).toBe(1);
    expect(await recoverRemoteSessionInbox(Date.now(), { includeLive: true })).toBe(0);
    expect(replies(topic.id)).toBe(1);
  });

  test("the room record, the ask consumption and the claim completion are one transaction", async () => {
    const topic = callerRoom();
    const requestId = `ar-atomic-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    // The injection records, then something after the record throws inside
    // the same transaction: nothing of it persists.
    setRemoteSessionAskReplyDeliverer(async (pending, label, body, kind, options) => {
      return deliverAskCallbackToCaller(pending, label, body, kind, {
        onRecorded: () => {
          options?.onRecorded?.();
          throw new Error("crash inside the commit");
        },
      });
    });
    const failed = await deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery });
    expect(failed.ok).toBe(false);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
    // A tell/ask/abort claim likewise completes with its enqueue.
    const tell = {
      kind: "tell" as const,
      requestId: `tell-${randomUUID()}`,
      from: { label: "hub/Origin" },
      message: "hi",
      depth: 1,
    };
    const agentRoom = registerTopic({
      title: `remote-inbox-target-${randomUUID()}`,
      userId: PRINCIPAL,
      agent: "claude",
      surface: "otium",
      surfaceScope: `ws-${randomUUID()}`,
    });
    expect(
      await deliverRemoteSessionInbox({ topic: agentRoom, userId: PRINCIPAL, delivery: tell }),
    ).toEqual({ ok: true, replayed: false });
    expect(getRemoteSessionInboxClaim(tell.requestId)?.state).toBe("completed");
  });

  test("an agent caller room: a record that fails after the enqueue withdraws the queue entry, so the retry is a fresh delivery", async () => {
    // The dangerous shape: the in-memory batch entry is created BEFORE the
    // durable record. If the record fails and the entry is left behind, the
    // sender's retry hits the enqueue dedupe, settles as if the answer had
    // landed, and the answer only ever existed in the memory of a process that
    // just failed a write.
    const topic = agentCallerRoom();
    const requestId = `ar-agent-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    setRemoteSessionAskReplyDeliverer(async (pending, label, body, kind, options) =>
      deliverAskCallbackToCaller(pending, label, body, kind, {
        onRecorded: () => {
          options?.onRecorded?.();
          throw new Error("record failed");
        },
      }),
    );
    const failed = await deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery });
    expect(failed.ok).toBe(false);
    expect(interSessionQueue.hasRequest(topic.id, requestId)).toBe(false);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();

    // The retry runs the whole delivery again and lands it exactly once.
    setRemoteSessionAskReplyDeliverer(null);
    expect(await deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery })).toEqual({
      ok: true,
      replayed: false,
    });
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionAsk(requestId)).toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    interSessionQueue.remove(topic.id, requestId);
  });

  test("the enqueue-dedupe branch consumes the ask and completes the claim atomically", async () => {
    const topic = agentCallerRoom();
    const requestId = `ar-dedupe-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    // An entry for this very request is already queued (its original callback
    // is still waiting for the room), so the delivery must not append twice —
    // but it still has to consume the ask and complete the claim, and those two
    // statements have to be one transaction.
    const queued = interSessionQueue.enqueue(topic.id, {
      topicId: topic.id,
      userId: PRINCIPAL,
      prompt: "[Reply from worker/Target]\n\nalready queued",
      origin: "worker/Target",
      requestId,
      askReplySources: [{ from: "worker/Target", requestId }],
    });
    expect(queued).toBe(true);

    // First, prove the atomicity: something failing inside that transaction
    // leaves BOTH the ask row and the (released) claim untouched.
    setRemoteSessionAskReplyDeliverer(async (pending, label, body, kind, options) =>
      deliverAskCallbackToCaller(pending, label, body, kind, {
        onRecorded: () => {
          options?.onRecorded?.();
          throw new Error("crash between the delete and the completion");
        },
      }),
    );
    const failed = await deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery });
    expect(failed.ok).toBe(false);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
    expect(interSessionQueue.hasRequest(topic.id, requestId)).toBe(true);

    // Then the clean run: no second append, ask consumed, claim completed.
    setRemoteSessionAskReplyDeliverer(null);
    expect(await deliverRemoteSessionInbox({ topic, userId: PRINCIPAL, delivery })).toEqual({
      ok: true,
      replayed: false,
    });
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    interSessionQueue.remove(topic.id, requestId);
  });
});
