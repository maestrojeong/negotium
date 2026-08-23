import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  RuntimeGatewayIdempotencyConflictError,
  submitRuntimeGatewayTurn,
} from "#application/submit-runtime-gateway-turn";
import { topicService } from "#application/topic-service";
import { fileHooks, setFileHooks } from "#runtime/file-hooks";
import { appendApiMessage, getApiMessage } from "#storage/api-messages";
import { deleteTopic, getTopic, setTopicSessionId } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import {
  findRuntimeGatewaySubmission,
  recordRuntimeGatewaySubmission,
} from "#storage/runtime-gateway-submissions";
import {
  cancelRuntimeUserTurnRequests,
  getRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";

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

    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      actorUserId: "actor-bob",
      actorLabel: "Bob",
      vaultUserId: "topic-owner",
      text: "fresh gateway turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.userMessages).toEqual([
      {
        prompt: "fresh gateway turn",
        actorUserId: "actor-alice",
        actorLabel: "Alice",
      },
      {
        prompt: "fresh gateway turn",
        actorUserId: "actor-bob",
        actorLabel: "Bob",
      },
    ]);

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
      text: "legacy gateway turn",
      clientMessageId,
      requestId,
    });
    expect(firstReplay.deduplicated).toBe(true);
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
