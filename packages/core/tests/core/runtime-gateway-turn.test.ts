import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { submitRuntimeGatewayTurn } from "#application/submit-runtime-gateway-turn";
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
    submitRuntimeGatewayTurn({
      topic: freshTopic,
      userId,
      text: "fresh gateway turn",
      clientMessageId: randomUUID(),
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.execution).toMatchObject({
      sessionId: null,
      sessionIdSpecified: true,
      conversationPrompts: ["fresh gateway turn"],
      loggedUserMessageCount: 0,
    });

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
