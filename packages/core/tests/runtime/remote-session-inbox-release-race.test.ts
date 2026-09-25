/**
 * PR9 review residual: releasing a `processing` inbox claim must never delete
 * a claim a live delivery has meanwhile completed (or re-bound).
 *
 * The bug this pins: `recoverRemoteSessionInbox` listed the expired claims
 * once, then — for a legacy/unverifiable ask-reply or a non-ask-reply kind —
 * released each one OUTSIDE the per-request lock with an unconditional
 * `DELETE ... WHERE request_id = ?`. A hub retry that took over the stale
 * claim and completed it in between (recovery was awaiting an earlier claim's
 * delivery) then lost its `completed` row: the next retry after a lost
 * response got 404 for an ask-reply (hub shows reply_dropped although the
 * reply landed) or was enqueued a second time for a tell.
 *
 * The gate: recovery is parked inside an earlier claim's delivery while the
 * live retry completes the later one; then recovery resumes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as inbox from "#runtime/remote-session-inbox";
import { listApiMessages } from "#storage/api-messages";
import { db } from "#storage/forum-db";
import {
  claimRemoteSessionInbox,
  completeRemoteSessionInboxClaim,
  getRemoteSessionAsk,
  getRemoteSessionInboxClaim,
  REMOTE_SESSION_INBOX_CLAIM_LEASE_MS,
  recordRemoteSessionAsk,
  releaseRemoteSessionInboxClaim,
  remoteSessionPayloadHash,
} from "#storage/remote-session";
import { registerTopic } from "#topics/create";

const { deliverRemoteSessionInbox, recoverRemoteSessionInbox, setRemoteSessionAskReplyDeliverer } =
  inbox;

const ASKER = "local";

function callerRoom(): { id: string; title: string; agent: undefined } {
  const topic = registerTopic({
    title: `release-race-caller-${randomUUID()}`,
    userId: ASKER,
    surface: "otium",
    surfaceScope: `ws-${randomUUID()}`,
  });
  db.run(
    "UPDATE api_topics SET kind = 'channel', response_policy = 'off', agent = NULL WHERE id = ?",
    [topic.id],
  );
  return { id: topic.id, title: topic.title, agent: undefined };
}

function agentRoom(): { id: string; title: string; agent: "claude" } {
  const topic = registerTopic({
    title: `release-race-target-${randomUUID()}`,
    userId: ASKER,
    agent: "claude",
    surface: "otium",
    surfaceScope: `ws-${randomUUID()}`,
  });
  return { id: topic.id, title: topic.title, agent: "claude" };
}

function askFor(topic: { id: string }, requestId: string): void {
  recordRemoteSessionAsk({
    requestId,
    callerTopicId: topic.id,
    userId: ASKER,
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

function replies(topicId: string): number {
  return listApiMessages(topicId).page.filter((m) => m.kind === "tell").length;
}

const EXPIRED = () => Date.now() - REMOTE_SESSION_INBOX_CLAIM_LEASE_MS - 1;

/**
 * An expired, verifiable ask-reply claim that sorts before anything the test
 * creates afterwards, plus a deliverer that parks recovery inside it until
 * `open()` — every other request goes to the real caller-room injection.
 */
async function parkRecoveryOnEarlierClaim(): Promise<{
  entered: Promise<void>;
  open: () => void;
}> {
  const topic = callerRoom();
  const requestId = `gate-${randomUUID()}`;
  askFor(topic, requestId);
  const delivery = replyDelivery(requestId);
  const identity = { userId: ASKER, actorUserId: ASKER, delivery };
  expect(
    claimRemoteSessionInbox({
      requestId,
      kind: "ask-reply",
      topicId: topic.id,
      payloadHash: inbox.remoteSessionInboxClaimHash(identity),
      payload: inbox.remoteSessionInboxEnvelope({ ...identity, askUserId: ASKER }),
      // Strictly older than the racing claim, so recovery reaches it first.
      now: EXPIRED() - 60_000,
    }),
  ).toBe("claimed");
  const real = (await import("#runtime/turn-runner")).deliverAskCallbackToCaller;
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  setRemoteSessionAskReplyDeliverer(async (pending, ...rest) => {
    if (pending.requestId === requestId) {
      signalEntered();
      await gate;
    }
    return real(pending, ...rest);
  });
  return { entered, open };
}

afterEach(() => {
  setRemoteSessionAskReplyDeliverer(null);
});

describe("recovery never releases a claim a live retry completed meanwhile", () => {
  test("legacy ask-reply claim: live retry completes between recovery's read and release => claim survives, the next retry replays", async () => {
    const { entered, open } = await parkRecoveryOnEarlierClaim();
    const topic = callerRoom();
    const requestId = `legacy-race-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    // Written by a node before the actor-bound digest: payload only.
    expect(
      claimRemoteSessionInbox({
        requestId,
        kind: "ask-reply",
        topicId: topic.id,
        payloadHash: remoteSessionPayloadHash(delivery),
        payload: delivery,
        now: EXPIRED(),
      }),
    ).toBe("claimed");

    const recovery = recoverRemoteSessionInbox(Date.now());
    await entered; // recovery has read both claims and is parked on the first
    // The hub's retry takes the stale legacy claim over and completes it.
    expect(
      await deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery }),
    ).toEqual({ ok: true, replayed: false });
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    open();
    await recovery;

    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    // Response lost; the hub retries once more: a replay, not a 404.
    expect(
      await deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery }),
    ).toEqual({ ok: true, replayed: true });
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionAsk(requestId)).toBeNull();
  });

  test("tell claim: live retry completes between recovery's read and release => claim survives, no second enqueue", async () => {
    const { entered, open } = await parkRecoveryOnEarlierClaim();
    const target = agentRoom();
    const delivery = {
      kind: "tell" as const,
      requestId: `tell-race-${randomUUID()}`,
      from: { label: "hub/Origin" },
      message: "hi",
      depth: 1,
    };
    // A process died between claim and enqueue (the claim never completed).
    expect(
      claimRemoteSessionInbox({
        requestId: delivery.requestId,
        kind: "tell",
        topicId: target.id,
        payloadHash: inbox.remoteSessionInboxClaimHash({
          userId: ASKER,
          actorUserId: ASKER,
          delivery,
        }),
        payload: inbox.remoteSessionInboxEnvelope({ userId: ASKER, actorUserId: ASKER, delivery }),
        now: EXPIRED(),
      }),
    ).toBe("claimed");

    const recovery = recoverRemoteSessionInbox(Date.now());
    await entered;
    expect(
      await deliverRemoteSessionInbox({
        topic: target,
        userId: ASKER,
        actorUserId: ASKER,
        delivery,
      }),
    ).toEqual({ ok: true, replayed: false });
    open();
    await recovery;

    expect(getRemoteSessionInboxClaim(delivery.requestId)?.state).toBe("completed");
    expect(
      await deliverRemoteSessionInbox({
        topic: target,
        userId: ASKER,
        actorUserId: ASKER,
        delivery,
      }),
    ).toEqual({ ok: true, replayed: true });
  });

  test("a delivery that recorded the answer but reported failure keeps its completed claim (retry replays, not 404)", async () => {
    const topic = callerRoom();
    const requestId = `recorded-false-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    setRemoteSessionAskReplyDeliverer(async (_pending, _label, _body, _kind, options) => {
      options?.onRecorded?.();
      return false;
    });
    expect(
      await deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery }),
    ).toMatchObject({ ok: false, status: 500 });
    // The answer is durable and the claim completed: the release after the
    // reported failure must not delete it, so the hub's retry is a replay.
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    expect(getRemoteSessionAsk(requestId)).toBeNull();
    setRemoteSessionAskReplyDeliverer(null);
    expect(
      await deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery }),
    ).toEqual({ ok: true, replayed: true });
  });
});

describe("releaseRemoteSessionInboxClaim is a compare-and-delete", () => {
  test("only a processing claim with the expected digest (and lease, when given) is deleted", () => {
    const requestId = `cas-${randomUUID()}`;
    const args = { requestId, kind: "abort" as const, topicId: "t", payloadHash: "h1" };
    const now = Date.now();
    expect(claimRemoteSessionInbox({ ...args, now })).toBe("claimed");
    const leaseUntil = getRemoteSessionInboxClaim(requestId)?.leaseUntil ?? 0;
    // Another digest, or a lease someone has since re-taken: untouched.
    expect(releaseRemoteSessionInboxClaim(requestId, { payloadHash: "h2" })).toBe(false);
    expect(
      releaseRemoteSessionInboxClaim(requestId, { payloadHash: "h1", leaseUntil: leaseUntil - 1 }),
    ).toBe(false);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("processing");
    // Completed: never deleted by a release.
    expect(completeRemoteSessionInboxClaim(requestId)).toBe(true);
    expect(releaseRemoteSessionInboxClaim(requestId, { payloadHash: "h1" })).toBe(false);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    // The matching processing claim is released.
    const other = `cas-ok-${randomUUID()}`;
    claimRemoteSessionInbox({ ...args, requestId: other, now });
    const lease = getRemoteSessionInboxClaim(other)?.leaseUntil ?? 0;
    expect(releaseRemoteSessionInboxClaim(other, { payloadHash: "h1", leaseUntil: lease })).toBe(
      true,
    );
    expect(getRemoteSessionInboxClaim(other)).toBeNull();
  });
});
