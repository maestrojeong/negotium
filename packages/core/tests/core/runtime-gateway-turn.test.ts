import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  RuntimeGatewayIdempotencyConflictError,
  submitRuntimeGatewayTurn,
} from "#application/submit-runtime-gateway-turn";
import { topicService } from "#application/topic-service";
import { deleteTopic, getTopic, setTopicSessionId } from "#storage/api-topics";
import { db } from "#storage/forum-db";
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
