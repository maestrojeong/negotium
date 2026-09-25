/**
 * PR9 security regression: a hub-routed inbox claim is bound to the principal
 * it was accepted under, and an interrupted ask-reply is re-verified before
 * recovery delivers it.
 *
 * The bug this pins: the ask-reply path persisted its claim + payload (the
 * delivery only, no actor) *before* checking the asserted actor against the
 * pending ask. A process killed in between left a `processing` claim that
 * `recoverRemoteSessionInbox` re-ran with no principal check at all — a reply
 * from another principal was injected into the asker's room and the ask row
 * consumed. The same `requestId` replayed by another actor was also accepted
 * as a replay, because the claim digest ignored the principal.
 *
 * New exports are reached through the namespace import so the tests that do
 * not need them also load (and fail for the right reason) on pre-fix code.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as inbox from "#runtime/remote-session-inbox";
import { listApiMessages } from "#storage/api-messages";
import { addParticipantToDB } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import {
  claimRemoteSessionInbox,
  getRemoteSessionAsk,
  getRemoteSessionInboxClaim,
  REMOTE_SESSION_INBOX_CLAIM_LEASE_MS,
  recordRemoteSessionAsk,
  remoteSessionPayloadHash,
} from "#storage/remote-session";
import { registerTopic } from "#topics/create";

const { deliverRemoteSessionInbox, recoverRemoteSessionInbox, setRemoteSessionAskReplyDeliverer } =
  inbox;

const ASKER = "local";
const OTHER = `other-${randomUUID()}`;

/** A human-only caller room (answers land as messages) where OTHER is a member too. */
function callerRoom(): { id: string; title: string; agent: undefined } {
  const topic = registerTopic({
    title: `actor-binding-caller-${randomUUID()}`,
    userId: ASKER,
    surface: "otium",
    surfaceScope: `ws-${randomUUID()}`,
  });
  db.run(
    "UPDATE api_topics SET kind = 'channel', response_policy = 'off', agent = NULL WHERE id = ?",
    [topic.id],
  );
  addParticipantToDB(topic.id, OTHER, "member");
  return { id: topic.id, title: topic.title, agent: undefined };
}

function agentRoom(): { id: string; title: string; agent: "claude" } {
  const topic = registerTopic({
    title: `actor-binding-target-${randomUUID()}`,
    userId: ASKER,
    agent: "claude",
    surface: "otium",
    surfaceScope: `ws-${randomUUID()}`,
  });
  addParticipantToDB(topic.id, OTHER, "member");
  return { id: topic.id, title: topic.title, agent: "claude" };
}

function askFor(topic: { id: string }, requestId: string, userId = ASKER): void {
  recordRemoteSessionAsk({
    requestId,
    callerTopicId: topic.id,
    userId,
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

afterEach(() => {
  setRemoteSessionAskReplyDeliverer(null);
});

describe("crash recovery never delivers an unverified ask-reply", () => {
  test("legacy payload (no principal) left by a crash between persist and check: dropped, no reply, ask row intact", async () => {
    // Exactly what the pre-fix live path persisted before its actor check:
    // the delivery only, hashed without the principal. Here it came from
    // OTHER, who did not raise the ask.
    const topic = callerRoom();
    const requestId = `legacy-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
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

    expect(await recoverRemoteSessionInbox(Date.now())).toBe(0);
    expect(await recoverRemoteSessionInbox(Date.now(), { includeLive: true })).toBe(0);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    // Dropped, not completed: the hub's retry goes through every live check.
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
  });

  test("the legitimate asker's retry after a dropped legacy claim still lands exactly once", async () => {
    const topic = callerRoom();
    const requestId = `legacy-retry-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    claimRemoteSessionInbox({
      requestId,
      kind: "ask-reply",
      topicId: topic.id,
      payloadHash: remoteSessionPayloadHash(delivery),
      payload: delivery,
      now: EXPIRED(),
    });
    await recoverRemoteSessionInbox(Date.now());
    // Another principal's retry is refused before anything is written.
    expect(
      await deliverRemoteSessionInbox({ topic, userId: OTHER, actorUserId: OTHER, delivery }),
    ).toMatchObject({ ok: false, status: 403, code: "actor_mismatch" });
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
    expect(
      await deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery }),
    ).toEqual({ ok: true, replayed: false });
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionAsk(requestId)).toBeNull();
  });

  test("a v2 envelope asserting another actor than the asker: dropped on recovery with no side effect", async () => {
    const topic = callerRoom();
    const requestId = `forged-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    const identity = { userId: OTHER, actorUserId: OTHER, delivery };
    claimRemoteSessionInbox({
      requestId,
      kind: "ask-reply",
      topicId: topic.id,
      payloadHash: inbox.remoteSessionInboxClaimHash(identity),
      // Even claiming it was verified against OTHER's ask does not help: the
      // current ask row belongs to ASKER.
      payload: inbox.remoteSessionInboxEnvelope({ ...identity, askUserId: OTHER }),
      now: EXPIRED(),
    });
    expect(await recoverRemoteSessionInbox(Date.now())).toBe(0);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
  });

  test("an envelope whose principal does not match the claim digest is dropped", async () => {
    const topic = callerRoom();
    const requestId = `swapped-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    claimRemoteSessionInbox({
      requestId,
      kind: "ask-reply",
      topicId: topic.id,
      // Digest bound to OTHER, envelope rewritten to ASKER.
      payloadHash: inbox.remoteSessionInboxClaimHash({
        userId: OTHER,
        actorUserId: OTHER,
        delivery,
      }),
      payload: inbox.remoteSessionInboxEnvelope({
        userId: ASKER,
        actorUserId: ASKER,
        delivery,
        askUserId: ASKER,
      }),
      now: EXPIRED(),
    });
    expect(await recoverRemoteSessionInbox(Date.now())).toBe(0);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
  });

  test("an actor-less (old hub) envelope is dropped on recovery once actorUserId is required", async () => {
    const topic = callerRoom();
    const requestId = `oldhub-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    const identity = { userId: ASKER, actorUserId: null, delivery };
    const claim = {
      requestId,
      kind: "ask-reply" as const,
      topicId: topic.id,
      payloadHash: inbox.remoteSessionInboxClaimHash(identity),
      payload: inbox.remoteSessionInboxEnvelope({ ...identity, askUserId: ASKER }),
    };
    claimRemoteSessionInbox({ ...claim, now: EXPIRED() });
    expect(await recoverRemoteSessionInbox(Date.now(), { requireActor: true })).toBe(0);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
    // With the flag off the legacy rule stands (participant): delivered.
    claimRemoteSessionInbox({ ...claim, now: EXPIRED() });
    expect(await recoverRemoteSessionInbox(Date.now(), { requireActor: false })).toBe(1);
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionAsk(requestId)).toBeNull();
  });

  test("a principal no longer a participant of the caller room is dropped on recovery", async () => {
    const topic = callerRoom();
    const requestId = `left-${randomUUID()}`;
    askFor(topic, requestId, OTHER);
    const delivery = replyDelivery(requestId);
    const identity = { userId: OTHER, actorUserId: OTHER, delivery };
    claimRemoteSessionInbox({
      requestId,
      kind: "ask-reply",
      topicId: topic.id,
      payloadHash: inbox.remoteSessionInboxClaimHash(identity),
      payload: inbox.remoteSessionInboxEnvelope({ ...identity, askUserId: OTHER }),
      now: EXPIRED(),
    });
    db.run("DELETE FROM topic_members WHERE topic_id = ? AND user_id = ?", [topic.id, OTHER]);
    expect(await recoverRemoteSessionInbox(Date.now())).toBe(0);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
  });
});

describe("the live ask-reply path verifies before it persists", () => {
  test("another actor's reply writes no claim at all (nothing for a crash to leave behind)", async () => {
    const topic = callerRoom();
    const requestId = `precheck-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    let injected = 0;
    setRemoteSessionAskReplyDeliverer(async () => {
      injected += 1;
      return true;
    });
    expect(
      await deliverRemoteSessionInbox({ topic, userId: OTHER, actorUserId: OTHER, delivery }),
    ).toMatchObject({ ok: false, status: 403, code: "actor_mismatch" });
    expect(getRemoteSessionInboxClaim(requestId)).toBeNull();
    expect(injected).toBe(0);
    expect(getRemoteSessionAsk(requestId)).not.toBeNull();
  });

  test("a crash after the verified claim is recovered from its envelope, exactly once", async () => {
    const topic = callerRoom();
    const requestId = `crash-verified-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    // Stop inside the injection: the claim (with its envelope) is persisted,
    // nothing reached the room. Snapshot the durable row as a crash would
    // leave it, then let this attempt fail and re-create the snapshot.
    let finish!: (value: boolean) => void;
    setRemoteSessionAskReplyDeliverer(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const live = deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const persisted = getRemoteSessionInboxClaim(requestId);
    expect(persisted?.state).toBe("processing");
    expect(persisted?.payload).toMatchObject({
      v: 2,
      userId: ASKER,
      actorUserId: ASKER,
      askUserId: ASKER,
      delivery,
    });
    finish(false);
    await live;
    setRemoteSessionAskReplyDeliverer(null);
    if (!persisted) throw new Error("no claim persisted");
    claimRemoteSessionInbox({
      requestId,
      kind: "ask-reply",
      topicId: topic.id,
      payloadHash: persisted.payloadHash,
      payload: persisted.payload,
      now: EXPIRED(),
    });
    expect(await recoverRemoteSessionInbox(Date.now())).toBe(1);
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionAsk(requestId)).toBeNull();
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
  });
});

describe("the claim digest binds the principal: same requestId, another actor => conflict", () => {
  test("tell / ask / abort", async () => {
    const target = agentRoom();
    const bodies = [
      {
        kind: "tell" as const,
        requestId: `tell-${randomUUID()}`,
        from: { label: "hub/Origin" },
        message: "hi",
        depth: 1,
      },
      {
        kind: "ask" as const,
        requestId: `ask-${randomUUID()}`,
        from: { label: "hub/Origin" },
        message: "q?",
        fromDepth: 0,
        remoteReply: {
          via: "hub" as const,
          hubUrl: "https://hub.example",
          token: `rsr1.${"a".repeat(40)}`,
          nodeName: "origin",
          topicId: "t",
          requestId: "",
        },
      },
      { kind: "abort" as const, requestId: `abort-${randomUUID()}` },
    ];
    for (const body of bodies) {
      const delivery =
        body.kind === "ask"
          ? { ...body, remoteReply: { ...body.remoteReply, requestId: body.requestId } }
          : body;
      expect(
        await deliverRemoteSessionInbox({
          topic: target,
          userId: ASKER,
          actorUserId: ASKER,
          delivery,
        }),
      ).toEqual({ ok: true, replayed: false });
      // Same principal again: a replay.
      expect(
        await deliverRemoteSessionInbox({
          topic: target,
          userId: ASKER,
          actorUserId: ASKER,
          delivery,
        }),
      ).toEqual({ ok: true, replayed: true });
      // Another actor with the same requestId and payload: a conflict.
      expect(
        await deliverRemoteSessionInbox({
          topic: target,
          userId: OTHER,
          actorUserId: OTHER,
          delivery,
        }),
      ).toMatchObject({ ok: false, status: 409 });
      // An actor-less (old hub) delivery under the same userId is another
      // identity too.
      expect(
        await deliverRemoteSessionInbox({ topic: target, userId: ASKER, delivery }),
      ).toMatchObject({ ok: false, status: 409 });
    }
  });

  test("ask-reply: after the asker's reply landed, another actor's retry is a conflict, not a replay", async () => {
    const topic = callerRoom();
    const requestId = `ar-conflict-${randomUUID()}`;
    askFor(topic, requestId);
    const delivery = replyDelivery(requestId);
    expect(
      await deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery }),
    ).toEqual({ ok: true, replayed: false });
    expect(
      await deliverRemoteSessionInbox({ topic, userId: ASKER, actorUserId: ASKER, delivery }),
    ).toEqual({ ok: true, replayed: true });
    expect(
      await deliverRemoteSessionInbox({ topic, userId: OTHER, actorUserId: OTHER, delivery }),
    ).toMatchObject({ ok: false, status: 409 });
    expect(replies(topic.id)).toBe(1);
  });

  test("a claim completed by the previous version (delivery-only digest) still answers a replay", async () => {
    const target = agentRoom();
    const delivery = {
      kind: "tell" as const,
      requestId: `legacy-done-${randomUUID()}`,
      from: { label: "hub/Origin" },
      message: "hi",
      depth: 1,
    };
    claimRemoteSessionInbox({
      requestId: delivery.requestId,
      kind: "tell",
      topicId: target.id,
      payloadHash: remoteSessionPayloadHash(delivery),
    });
    db.run(
      "UPDATE remote_session_inbox_claims SET state = 'completed', payload_json = NULL WHERE request_id = ?",
      [delivery.requestId],
    );
    expect(
      await deliverRemoteSessionInbox({
        topic: target,
        userId: ASKER,
        actorUserId: ASKER,
        delivery,
      }),
    ).toEqual({ ok: true, replayed: true });
  });
});
