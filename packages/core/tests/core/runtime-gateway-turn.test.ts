import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  RuntimeGatewayIdempotencyConflictError,
  submitRuntimeGatewayTurn,
} from "#application/submit-runtime-gateway-turn";
import { topicService } from "#application/topic-service";
import { fileHooks, setFileHooks } from "#runtime/file-hooks";
import { renderUserTurnBatch } from "#runtime/user-turn-envelope";
import { appendApiMessage, getApiMessage, listApiMessages } from "#storage/api-messages";
import { deleteTopic, getTopic, setTopicSessionId } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { listRuntimeEventsAfter } from "#storage/runtime-events";
import {
  findRuntimeGatewaySubmission,
  recordRuntimeGatewaySubmission,
} from "#storage/runtime-gateway-submissions";
import {
  claimRuntimeTurnLease,
  getRuntimeTurnLease,
  releaseRuntimeTurnLease,
} from "#storage/runtime-leases";
import {
  cancelRuntimeUserTurnRequests,
  claimNextRuntimeUserTurnRequest,
  completeRuntimeUserTurnRequest,
  enqueueRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
  markRuntimeUserTurnRunning,
} from "#storage/runtime-turn-requests";
import type { MessageDto } from "#types/api";
import { resetRuntimeTurnQueue } from "../fixtures/runtime-queue";

test("runtime gateway snapshots the pre-turn provider session for durable handoff", () => {
  const userId = `gateway-session-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway session ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const firstSubmission = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      actorLabel: "Alice",
      vaultUserId: "topic-owner",
      text: "fresh gateway turn",
      clientMessageId: randomUUID(),
    });
    expect(firstSubmission.message).toMatchObject({
      authorId: "actor-alice",
      authorName: "Alice",
    });
    const duplicate = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      actorLabel: "Alice",
      vaultUserId: "topic-owner",
      text: "fresh gateway turn",
      clientMessageId: firstSubmission.clientMessageId,
      requestId: firstSubmission.requestId,
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.message.id).toBe(firstSubmission.message.id);
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId: "actor-alice",
        text: "changed payload",
        clientMessageId: firstSubmission.clientMessageId,
        requestId: firstSubmission.requestId,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId: "actor-alice",
        actorLabel: "Alicia",
        vaultUserId: "topic-owner",
        text: "fresh gateway turn",
        clientMessageId: firstSubmission.clientMessageId,
        requestId: firstSubmission.requestId,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId: "actor-alice",
        actorLabel: "Alice",
        vaultUserId: "different-owner",
        text: "fresh gateway turn",
        clientMessageId: firstSubmission.clientMessageId,
        requestId: firstSubmission.requestId,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId: "actor-alice",
        actorLabel: "Alice",
        vaultUserId: "topic-owner",
        text: "fresh gateway turn",
        clientMessageId: firstSubmission.clientMessageId,
        requestId: firstSubmission.requestId,
        allowAutoContinue: false,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId: "actor-mallory",
        text: "fresh gateway turn",
        clientMessageId: firstSubmission.clientMessageId,
        requestId: firstSubmission.requestId,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
    expect(getRuntimeUserTurnRequest(topic.id)).toMatchObject({
      userId,
      userMessages: [
        {
          prompt: "fresh gateway turn",
          actorUserId: "actor-alice",
          actorLabel: "Alice",
        },
      ],
      execution: {
        actorUserId: "actor-alice",
        sessionId: null,
        sessionIdSpecified: true,
        conversationPrompts: ["fresh gateway turn"],
        loggedUserMessageCount: 0,
        vaultUserId: "topic-owner",
      },
    });

    // A second person's message is not folded onto Alice's pending one: the
    // batch would run with one actor's identity and assertion, so Bob's turn
    // queues behind hers as its own request and carries only his message.
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-bob",
      actorLabel: "Bob",
      vaultUserId: "topic-owner",
      text: "fresh gateway turn",
      clientMessageId: randomUUID(),
    });
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM runtime_user_turn_requests WHERE topic_id = ?",
        )
        .get(topic.id)?.n,
    ).toBe(2);
    expect(getRuntimeUserTurnRequest(topic.id)).toMatchObject({
      userMessages: [{ prompt: "fresh gateway turn", actorUserId: "actor-bob", actorLabel: "Bob" }],
      execution: { actorUserId: "actor-bob" },
    });

    cancelRuntimeUserTurnRequests(topic.id);

    setTopicSessionId(topic.id, "stable-session", { reason: "test", agent: "codex" });
    submitRuntimeGatewayTurn({
      topic: getTopic(topic.id)!,
      userId,
      text: "resumed gateway turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution).toMatchObject({
      sessionId: "stable-session",
      sessionIdSpecified: true,
    });
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});

// Regression for a pre-0.2.5 `runtime_gateway_submissions` row that never
// recorded a `payload_hash` (the column, and vaultUserId/allowAutoContinue
// comparison, were added later). The legacy branch only ever compared
// author/text/id fields, so a replay under the same key with a different
// `vaultUserId` or `allowAutoContinue` silently replayed the old ACK instead
// of conflicting.
test("runtime gateway backfills a legacy null payload_hash row so later replays are checked in full", () => {
  const userId = `gateway-legacy-hash-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway legacy hash ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");

    const clientMessageId = randomUUID();
    const requestId = clientMessageId;
    const messageId = randomUUID();
    appendApiMessage(
      {
        id: messageId,
        topicId: freshTopic.id,
        authorId: "actor-alice",
        authorName: "Alice",
        sourceAdapter: "runtime-gateway",
        sourceMessageId: clientMessageId,
        text: "legacy gateway turn",
        createdAt: new Date().toISOString(),
      },
      { notify: false },
    );
    // Simulate a submission recorded before `payload_hash` existed: no
    // `payloadHash` field at all, same shape `recordRuntimeGatewaySubmission`
    // wrote pre-0.2.5.
    recordRuntimeGatewaySubmission({
      clientMessageId,
      requestId,
      topicId: freshTopic.id,
      messageId,
      userId,
      createdAt: new Date().toISOString(),
      ackCursor: 0,
      messageCursor: 0,
    });
    expect(findRuntimeGatewaySubmission(clientMessageId, requestId)?.payloadHash).toBeUndefined();

    // First replay under the legacy key: matches every field the legacy
    // branch can check, so it is accepted as a duplicate (there is no stored
    // vaultUserId to compare against) — but the fix must now backfill a
    // payload hash from *this* call so the key stops being a blank check.
    const firstReplay = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      actorLabel: "Alice",
      vaultUserId: "vault-a",
      sourceAdapter: "telegram",
      text: "legacy gateway turn",
      clientMessageId,
      requestId,
    });
    expect(firstReplay.deduplicated).toBe(true);
    expect(firstReplay.message.sourceAdapter).toBe("runtime-gateway");
    expect(findRuntimeGatewaySubmission(clientMessageId, requestId)?.payloadHash).toBeDefined();

    // A later replay with the same author/text/ids but a different Vault
    // must now be rejected instead of silently reusing the old ACK.
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId: "actor-alice",
        actorLabel: "Alice",
        vaultUserId: "vault-b",
        text: "legacy gateway turn",
        clientMessageId,
        requestId,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);

    // ...and one with `allowAutoContinue` flipped must also be rejected.
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId: "actor-alice",
        actorLabel: "Alice",
        vaultUserId: "vault-a",
        text: "legacy gateway turn",
        clientMessageId,
        requestId,
        allowAutoContinue: false,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});

test("respond:false records the message without queueing an AI turn", () => {
  const userId = `gateway-silent-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway silent ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");

    const silent = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "just talking to the humans",
      clientMessageId: randomUUID(),
      respond: false,
    });
    // The canonical transcript is still the node's, even when the room's AI is
    // off or mention-only — otherwise Terminal and Telegram see a room with
    // holes in it.
    expect(silent.deduplicated).toBe(false);
    expect(silent.ackCursor).toBeGreaterThan(0);
    expect(silent.messageCursor).toBeGreaterThan(0);
    expect(getApiMessage(topic.id, silent.messageId)?.text).toBe("just talking to the humans");
    expect(getRuntimeUserTurnRequest(topic.id)).toBeNull();

    // Same key replayed with `respond` flipped is a different turn: reusing the
    // silent ACK would drop the answer with nothing to tell the caller.
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        text: "just talking to the humans",
        clientMessageId: silent.clientMessageId,
        requestId: silent.requestId,
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
    // Replaying it unchanged still dedupes, and still queues nothing.
    expect(
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        text: "just talking to the humans",
        clientMessageId: silent.clientMessageId,
        requestId: silent.requestId,
        respond: false,
      }).deduplicated,
    ).toBe(true);
    expect(getRuntimeUserTurnRequest(topic.id)).toBeNull();

    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "now please answer",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.userMessages).toEqual([
      { prompt: "now please answer", actorUserId: userId },
    ]);
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});

test("runtime gateway persists staged attachments into the message and durable turn", () => {
  const userId = `gateway-files-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway files ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  const previousHooks = fileHooks();
  const fileId = randomUUID();
  setFileHooks({
    resolveAttachmentByFileId: (id) =>
      id === fileId
        ? {
            id,
            type: "file",
            filename: "report.html",
            url: `/files/${id}`,
            mimeType: "text/html",
            sizeBytes: 17,
          }
        : null,
    resolveUploadedFilePathByFileId: () => null,
    storeLocalFileAsUpload: () => null,
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const submission = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "",
      clientMessageId: randomUUID(),
      attachments: [fileId],
    });
    expect(submission.message.attachments?.[0]).toMatchObject({
      id: fileId,
      filename: "report.html",
      mimeType: "text/html",
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.userMessages).toEqual([
      { prompt: "", actorUserId: userId, attachments: [fileId] },
    ]);
  } finally {
    setFileHooks(previousHooks);
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});

// Regression: the adapter's capability grant has to survive the hop into the
// durable turn request. The turn worker builds the runtime MCP from
// `execution`, so a gateway that grants visual tools but has them dropped here
// produces a turn whose prompt advertises `show_html` while the MCP omits it.
test("runtime gateway forwards the adapter's tool capabilities to the durable turn", () => {
  const userId = `gateway-caps-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway caps ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "draw me a chart",
      clientMessageId: randomUUID(),
      visualTools: true,
      fileDeliveryTools: true,
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution).toMatchObject({
      visualTools: true,
      fileDeliveryTools: true,
    });

    cancelRuntimeUserTurnRequests(topic.id);

    // Default-deny: a gateway that says nothing grants nothing.
    submitRuntimeGatewayTurn({
      topic: getTopic(topic.id)!,
      userId,
      text: "draw me another chart",
      clientMessageId: randomUUID(),
    });
    const execution = getRuntimeUserTurnRequest(topic.id)?.execution;
    expect(execution?.visualTools).toBeUndefined();
    expect(execution?.fileDeliveryTools).toBeUndefined();
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});

test("runtime gateway keeps a silent programmatic turn out of the canonical transcript", () => {
  const userId = `gateway-silent-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway silent ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const clientMessageId = randomUUID();
    const submission = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "hidden ask context",
      clientMessageId,
      silent: true,
    });

    expect(getApiMessage(topic.id, submission.message.id)).toBeNull();
    expect(getRuntimeUserTurnRequest(topic.id)).toMatchObject({
      execution: { silent: true },
      userMessages: [{ prompt: "hidden ask context" }],
    });
    expect(
      listRuntimeEventsAfter(0).filter(
        (event) => event.topicId === topic.id && event.type === "message",
      ),
    ).toEqual([]);

    const duplicate = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "hidden ask context",
      clientMessageId,
      requestId: submission.requestId,
      silent: true,
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.message.id).toBe(submission.message.id);
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});

test("a quoted reply keeps its channel placement while a thread reply leaves it", () => {
  const userId = `gateway-quote-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway quote ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const quoted: MessageDto = {
      id: randomUUID(),
      topicId: topic.id,
      authorId: "ai",
      agentType: "claude",
      text: "배포 스크립트 권한 문제로 실패했습니다.",
      createdAt: new Date().toISOString(),
    };
    appendApiMessage(quoted, { notify: false });

    const quote = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "이 로그 원인 좀 봐줘",
      clientMessageId: randomUUID(),
      parentId: quoted.id,
    });
    // A quote is a pointer, not thread membership: it must stay in the channel
    // listing, which excludes anything carrying a thread root.
    expect(quote.message.parentId).toBe(quoted.id);
    expect(quote.message.threadRootId).toBeUndefined();
    expect(listApiMessages(topic.id).page.map((message) => message.id)).toContain(quote.message.id);
    const quotePrompt = renderUserTurnBatch(
      getRuntimeUserTurnRequest(topic.id)?.userMessages ?? [],
    );
    expect(quotePrompt).toContain("[Replying to @AI (claude)]");
    expect(quotePrompt).toContain("> 배포 스크립트 권한 문제로 실패했습니다.");
    expect(quotePrompt).not.toContain("In thread");
    cancelRuntimeUserTurnRequests(topic.id);

    const reply = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "권한만 고치면 되나?",
      clientMessageId: randomUUID(),
      threadRootId: quoted.id,
    });
    expect(reply.message.threadRootId).toBe(quoted.id);
    expect(listApiMessages(topic.id).page.map((message) => message.id)).not.toContain(
      reply.message.id,
    );
    expect(renderUserTurnBatch(getRuntimeUserTurnRequest(topic.id)?.userMessages ?? [])).toContain(
      "[In thread #",
    );
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("the same key with a different quote target is a different turn", () => {
  const userId = `gateway-quote-hash-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway quote hash ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const clientMessageId = randomUUID();
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "같은 텍스트",
      clientMessageId,
      parentId: "parent-a",
    });
    // Replaying one key with another quote target would otherwise reuse the ACK
    // and attach the answer to the wrong message.
    expect(() =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        text: "같은 텍스트",
        clientMessageId,
        parentId: "parent-b",
      }),
    ).toThrow(RuntimeGatewayIdempotencyConflictError);
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("runtime gateway keeps the host's actor room assertion on the durable turn row", () => {
  const userId = `gateway-scope-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway scope ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const actorTopicScope = { visibleNodeTopicIds: ["n-a", "n-b"], ownedNodeTopicIds: ["n-b"] };
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      actorTopicScope,
      text: "scoped turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution).toMatchObject({
      actorUserId: "actor-alice",
      actorTopicScope,
    });

    // A steering message from the same person that arrives while the first is
    // pending folds into one batch; the batch runs with the *intersection* of
    // the two assertions, so it can never reach a room either message could
    // not (retries read the merged row, so nothing is lost across a restart).
    const later = { visibleNodeTopicIds: ["n-a", "n-z"], ownedNodeTopicIds: ["n-a"] };
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      actorTopicScope: later,
      text: "second scoped turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution?.actorTopicScope).toEqual({
      visibleNodeTopicIds: ["n-a"],
      ownedNodeTopicIds: [],
    });

    // No assertion from the host leaves the batch without one — never a stale
    // copy widened from an earlier message.
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      text: "unscoped turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution?.actorTopicScope).toBeUndefined();
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("runtime gateway keeps the hub's remote-session grant on the durable turn row and merges it fail-closed", () => {
  const userId = `gateway-grant-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway grant ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  const capability = (exp: number) =>
    `rsc1.${Buffer.from(JSON.stringify({ v: 1, t: "rsc", e: exp })).toString("base64url")}.c2ln`;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const early = { hubUrl: "https://hub.example", capability: capability(1_800_000_100) };
    const first = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      remoteSession: early,
      text: "granted turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution?.remoteSession).toEqual(early);
    // Same person, later message with a longer-lived grant: the merged batch
    // keeps the one that expires last.
    const late = { hubUrl: "https://hub.example", capability: capability(1_800_000_900) };
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      remoteSession: late,
      text: "second granted turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution?.remoteSession).toEqual(late);
    // A message without a grant leaves the batch without one.
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      text: "ungranted turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution?.remoteSession).toBeUndefined();
    // Like the assertion, the grant describes the caller, not the message: a
    // replay of the first key with a different grant is a duplicate.
    const replay = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      remoteSession: late,
      text: "granted turn",
      clientMessageId: first.clientMessageId,
    });
    expect(replay.deduplicated).toBe(true);
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

/**
 * Policy, recorded on purpose: the room assertion is a property of the caller,
 * not of the message, so it is outside the idempotency hash — a replay of the
 * same `clientMessageId` with a *different* assertion is acknowledged as a
 * duplicate and the turn keeps the assertion it was first accepted with. The
 * flip side is that a revocation the hub learns of between the first submit
 * and a replay is not applied to that turn (see RUNTIME-GATEWAY-CONTRACT.md,
 * "Known limitations"). Changing this is a product decision, not a bug fix.
 */
test("runtime gateway replay keeps the first-accepted actor room assertion", () => {
  const userId = `gateway-replay-scope-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway replay scope ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const clientMessageId = randomUUID();
    const first = { visibleNodeTopicIds: ["n-a", "n-b"], ownedNodeTopicIds: ["n-b"] };
    const accepted = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      actorTopicScope: first,
      text: "replayed turn",
      clientMessageId,
    });
    expect(accepted.deduplicated).toBe(false);

    const replayed = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-alice",
      // The hub has since removed n-b: the replay carries the narrower view.
      actorTopicScope: { visibleNodeTopicIds: ["n-a"], ownedNodeTopicIds: [] },
      text: "replayed turn",
      clientMessageId,
    });
    expect(replayed.deduplicated).toBe(true);
    expect(replayed.requestId).toBe(accepted.requestId);
    // Stale by design: the durable row still says what the first submit said.
    expect(getRuntimeUserTurnRequest(topic.id)?.execution?.actorTopicScope).toEqual(first);
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

/**
 * Steering follows the merge rule. The person whose turn is running may steer
 * it with a follow-up (abort + resume as one batch, as before). Anyone else's
 * message leaves that answer alone and waits in the queue as its own turn, with
 * its own actor and assertion. A running turn whose actor was never recorded is
 * treated as someone else's — the conservative reading.
 */
function startRunningTurn(topicId: string, requestId: string, worker: string) {
  const claimed = claimNextRuntimeUserTurnRequest(worker);
  expect(claimed?.requestId).toBe(requestId);
  const queryId = `query-${randomUUID()}`;
  expect(markRuntimeUserTurnRunning(topicId, requestId, worker, queryId)).toBe(true);
  expect(claimRuntimeTurnLease({ topicId, queryId, origin: "user", ownerId: worker })).toBe(true);
  return queryId;
}

function queueRows(topicId: string) {
  return db
    .query<{ request_id: string; execution_json: string | null; status: string }, [string]>(
      "SELECT request_id, execution_json, status FROM runtime_user_turn_requests WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(topicId)
    .map((row) => ({
      requestId: row.request_id,
      status: row.status,
      execution: JSON.parse(row.execution_json ?? "{}") as {
        actorUserId?: string;
        actorTopicScope?: unknown;
      },
    }));
}

test("runtime gateway does not abort another person's running turn; the new message queues behind it", () => {
  resetRuntimeTurnQueue();
  const userId = `gateway-steer-other-${randomUUID()}`;
  const worker = `worker-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway steer ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  let queryId: string | undefined;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const aliceScope = { visibleNodeTopicIds: ["room-a"], ownedNodeTopicIds: ["room-a"] };
    const bobScope = { visibleNodeTopicIds: ["room-b"], ownedNodeTopicIds: [] as string[] };
    const alice = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "alice",
      actorTopicScope: aliceScope,
      text: "alice's question",
      clientMessageId: randomUUID(),
    });
    queryId = startRunningTurn(topic.id, alice.requestId, worker);

    const bob = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "bob",
      actorTopicScope: bobScope,
      text: "bob's question",
      clientMessageId: randomUUID(),
    });
    // (1) Alice's turn keeps running: no abort was requested on its lease …
    expect(getRuntimeTurnLease(topic.id)?.abortRequested).toBe(false);
    // … and Bob's request is a separate pending entry behind it, not a merge.
    expect(queueRows(topic.id)).toMatchObject([
      {
        requestId: alice.requestId,
        status: "running",
        execution: { actorUserId: "alice", actorTopicScope: aliceScope },
      },
      {
        requestId: bob.requestId,
        status: "pending",
        execution: { actorUserId: "bob", actorTopicScope: bobScope },
      },
    ]);
    // Bob cannot be claimed while Alice's worker holds the topic …
    expect(claimNextRuntimeUserTurnRequest(`other-${worker}`)).toBeNull();
    // … and once she is done, Bob runs as his own turn with his own authority.
    expect(completeRuntimeUserTurnRequest(topic.id, alice.requestId, worker)).toBe(true);
    releaseRuntimeTurnLease(topic.id, queryId, worker);
    queryId = undefined;
    const next = claimNextRuntimeUserTurnRequest(worker);
    expect(next?.requestId).toBe(bob.requestId);
    expect(next?.execution).toMatchObject({ actorUserId: "bob", actorTopicScope: bobScope });
    expect(next?.userMessages.map((message) => message.prompt)).toEqual(["bob's question"]);
  } finally {
    if (queryId) releaseRuntimeTurnLease(topic.id, queryId, worker);
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("runtime gateway still steers a running turn with the same person's follow-up", () => {
  resetRuntimeTurnQueue();
  const userId = `gateway-steer-same-${randomUUID()}`;
  const worker = `worker-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway steer ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  let queryId: string | undefined;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const first = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "alice",
      text: "first thought",
      clientMessageId: randomUUID(),
    });
    queryId = startRunningTurn(topic.id, first.requestId, worker);
    const second = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "alice",
      text: "actually, also this",
      clientMessageId: randomUUID(),
    });
    // (2) Same person: abort requested and the two messages are one batch.
    expect(getRuntimeTurnLease(topic.id)?.abortRequested).toBe(true);
    expect(getRuntimeTurnLease(topic.id)?.abortReason).toBe("internal");
    expect(queueRows(topic.id).map((row) => row.requestId)).toEqual([second.requestId]);
    expect(getRuntimeUserTurnRequest(topic.id)).toMatchObject({
      userMessages: [{ prompt: "first thought" }, { prompt: "actually, also this" }],
      execution: { actorUserId: "alice", supersededRequestIds: [first.requestId] },
    });
  } finally {
    if (queryId) releaseRuntimeTurnLease(topic.id, queryId, worker);
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("runtime gateway never aborts a running turn whose actor is unknown", () => {
  resetRuntimeTurnQueue();
  const userId = `gateway-steer-unknown-${randomUUID()}`;
  const worker = `worker-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway steer ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  let queryId: string | undefined;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    // A row without a recorded actor: a turn the node started for itself, or
    // one written before the field existed.
    const legacy = enqueueRuntimeUserTurnRequest({
      topicId: topic.id,
      userId,
      prompt: "started by the node",
      allowAutoContinue: true,
      execution: { conversationPrompts: ["started by the node"], loggedUserMessageCount: 0 },
    });
    queryId = startRunningTurn(topic.id, legacy, worker);
    const incoming = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: userId,
      text: "a person speaks",
      clientMessageId: randomUUID(),
    });
    // (3) Unknown is not "the same person": the running turn is left alone and
    // the message queues behind it rather than being folded into it.
    expect(getRuntimeTurnLease(topic.id)?.abortRequested).toBe(false);
    expect(queueRows(topic.id).map((row) => [row.requestId, row.status])).toEqual([
      [legacy, "running"],
      [incoming.requestId, "pending"],
    ]);
  } finally {
    if (queryId) releaseRuntimeTurnLease(topic.id, queryId, worker);
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

/**
 * A worker finishing one turn while another worker polls and a gateway submit
 * lands: the queue must stay per-actor FIFO and hand each request to exactly
 * one worker. Simulated through the storage functions in one process — they
 * are the same SQLite transactions two processes would run, and there is no
 * interleaving here that the transactions do not serialize.
 */
test("completion, the next claim and a new submit overlapping keep per-actor FIFO and at-most-once", () => {
  resetRuntimeTurnQueue();
  const userId = `gateway-race-${randomUUID()}`;
  const workerA = `worker-a-${randomUUID()}`;
  const workerB = `worker-b-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway race ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  let queryId: string | undefined;
  let bobQueryId: string | undefined;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const submit = (actorUserId: string, text: string) =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId,
        actorTopicScope: { visibleNodeTopicIds: [`room-${actorUserId}`], ownedNodeTopicIds: [] },
        text,
        clientMessageId: randomUUID(),
      });
    const alice1 = submit("alice", "alice 1");
    queryId = startRunningTurn(topic.id, alice1.requestId, workerA);
    const bob = submit("bob", "bob 1");
    // While Alice runs, neither worker can take Bob.
    expect(claimNextRuntimeUserTurnRequest(workerB)).toBeNull();
    expect(claimNextRuntimeUserTurnRequest(workerA)).toBeNull();

    // Alice completes; in the same instant a second Alice message arrives
    // and both workers poll. Alice's new message must not fold into Bob's
    // pending row (different actor) and nothing is aborted (nothing runs).
    expect(completeRuntimeUserTurnRequest(topic.id, alice1.requestId, workerA)).toBe(true);
    releaseRuntimeTurnLease(topic.id, queryId, workerA);
    queryId = undefined;
    const alice2 = submit("alice", "alice 2");
    expect(getRuntimeTurnLease(topic.id)).toBeNull();
    expect(queueRows(topic.id).map((row) => [row.requestId, row.execution.actorUserId])).toEqual([
      [bob.requestId, "bob"],
      [alice2.requestId, "alice"],
    ]);
    const first = claimNextRuntimeUserTurnRequest(workerB);
    expect(first?.requestId).toBe(bob.requestId);
    // At most once: the other worker sees the topic as taken, not Alice 2.
    expect(claimNextRuntimeUserTurnRequest(workerA)).toBeNull();
    bobQueryId = `query-${randomUUID()}`;
    expect(markRuntimeUserTurnRunning(topic.id, bob.requestId, workerB, bobQueryId)).toBe(true);
    expect(
      claimRuntimeTurnLease({
        topicId: topic.id,
        queryId: bobQueryId,
        origin: "user",
        ownerId: workerB,
      }),
    ).toBe(true);
    // A third Alice message while Bob runs: queued behind, folded with Alice 2
    // (same actor, adjacent), Bob untouched.
    submit("alice", "alice 3");
    expect(getRuntimeTurnLease(topic.id)?.abortRequested).toBe(false);
    const rows = queueRows(topic.id);
    expect(rows.map((row) => [row.execution.actorUserId, row.status])).toEqual([
      ["bob", "running"],
      ["alice", "pending"],
    ]);
    expect(getRuntimeUserTurnRequest(topic.id)?.userMessages.map((m) => m.prompt)).toEqual([
      "alice 2",
      "alice 3",
    ]);
  } finally {
    if (queryId) releaseRuntimeTurnLease(topic.id, queryId, workerA);
    if (bobQueryId) releaseRuntimeTurnLease(topic.id, bobQueryId, workerB);
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("a stale running claim is reclaimed in place, keeping A/B/A order", () => {
  resetRuntimeTurnQueue();
  const userId = `gateway-stale-${randomUUID()}`;
  const dead = `worker-dead-${randomUUID()}`;
  const live = `worker-live-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway stale ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  let queryId: string | undefined;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const submit = (actorUserId: string, text: string) =>
      submitRuntimeGatewayTurn({
        topic: freshTopic,
        userId,
        actorUserId,
        text,
        clientMessageId: randomUUID(),
      });
    const a1 = submit("alice", "a1");
    queryId = startRunningTurn(topic.id, a1.requestId, dead);
    const b = submit("bob", "b");
    const a2 = submit("alice", "a2");
    expect(queueRows(topic.id).map((row) => row.requestId)).toEqual([
      a1.requestId,
      b.requestId,
      a2.requestId,
    ]);
    // The worker running A1 dies: its claim and lease stop heart-beating.
    const stale = Date.now() - 60_000;
    db.query("UPDATE runtime_user_turn_requests SET claimed_at = ? WHERE request_id = ?").run(
      stale,
      a1.requestId,
    );
    db.query("UPDATE runtime_turn_leases SET heartbeat_at = ? WHERE topic_id = ?").run(
      stale,
      topic.id,
    );
    // The reclaim takes A1 itself — the oldest row — not B or A2 ahead of it.
    const reclaimed = claimNextRuntimeUserTurnRequest(live);
    expect(reclaimed?.requestId).toBe(a1.requestId);
    expect(reclaimed?.claimedBy).toBe(live);
    expect(reclaimed?.userMessages.map((m) => m.prompt)).toEqual(["a1"]);
    // The dead worker's late completion no longer matches the claim.
    expect(completeRuntimeUserTurnRequest(topic.id, a1.requestId, dead)).toBe(false);
    expect(completeRuntimeUserTurnRequest(topic.id, a1.requestId, live)).toBe(true);
    releaseRuntimeTurnLease(topic.id, queryId, dead);
    queryId = undefined;
    expect(claimNextRuntimeUserTurnRequest(live)?.requestId).toBe(b.requestId);
    expect(completeRuntimeUserTurnRequest(topic.id, b.requestId, live)).toBe(true);
    expect(claimNextRuntimeUserTurnRequest(live)?.requestId).toBe(a2.requestId);
  } finally {
    if (queryId) releaseRuntimeTurnLease(topic.id, queryId, dead);
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("the same person in another thread does not steer the running turn", () => {
  resetRuntimeTurnQueue();
  const userId = `gateway-thread-${randomUUID()}`;
  const worker = `worker-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway thread ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  let queryId: string | undefined;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const channel = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "alice",
      text: "in the channel",
      clientMessageId: randomUUID(),
    });
    queryId = startRunningTurn(topic.id, channel.requestId, worker);
    const root: MessageDto = {
      id: randomUUID(),
      topicId: topic.id,
      authorId: "alice",
      text: "thread root",
      createdAt: new Date().toISOString(),
    };
    appendApiMessage(root, { notify: false });
    const threaded = submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "alice",
      text: "in a thread",
      clientMessageId: randomUUID(),
      threadRootId: root.id,
    });
    expect(getRuntimeTurnLease(topic.id)?.abortRequested).toBe(false);
    expect(queueRows(topic.id).map((row) => [row.requestId, row.status])).toEqual([
      [channel.requestId, "running"],
      [threaded.requestId, "pending"],
    ]);
  } finally {
    if (queryId) releaseRuntimeTurnLease(topic.id, queryId, worker);
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});

test("a duplicate clientMessageId while its turn is active neither aborts nor re-enqueues", () => {
  resetRuntimeTurnQueue();
  const userId = `gateway-dup-${randomUUID()}`;
  const worker = `worker-${randomUUID()}`;
  const topic = topicService.create({
    title: `Gateway dup ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  let queryId: string | undefined;
  try {
    const freshTopic = getTopic(topic.id);
    if (!freshTopic) throw new Error("topic was not created");
    const clientMessageId = randomUUID();
    const params = {
      topic: freshTopic,
      userId,
      actorUserId: "alice",
      actorTopicScope: { visibleNodeTopicIds: ["room-a"], ownedNodeTopicIds: [] },
      text: "once",
      clientMessageId,
    };
    const first = submitRuntimeGatewayTurn(params);
    queryId = startRunningTurn(topic.id, first.requestId, worker);
    const replay = submitRuntimeGatewayTurn(params);
    expect(replay.deduplicated).toBe(true);
    expect(replay.messageId).toBe(first.messageId);
    expect(getRuntimeTurnLease(topic.id)?.abortRequested).toBe(false);
    expect(queueRows(topic.id)).toMatchObject([{ requestId: first.requestId, status: "running" }]);
    expect(listApiMessages(topic.id).page.filter((m) => m.text === "once")).toHaveLength(1);
  } finally {
    if (queryId) releaseRuntimeTurnLease(topic.id, queryId, worker);
    cancelRuntimeUserTurnRequests(topic.id);
    deleteTopic(topic.id);
  }
});
