import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ensurePersonalGeneral, getTopic, TopicServiceError, topicService } from "@negotium/core";
import { runtimeBus } from "#bus";
import { getRuntimeTopicEpoch } from "#storage/runtime-topic-state";
import {
  claimNextRuntimeUserTurnRequest,
  completeRuntimeUserTurnRequest,
  enqueueRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";

test("topicService creates topics and centralizes owner authorization", async () => {
  const owner = `topic-service-owner-${randomUUID()}`;
  const member = `topic-service-member-${randomUUID()}`;
  const topic = topicService.create({
    title: `Topic service ${randomUUID()}`,
    userId: owner,
    agent: "codex",
  });
  expect(getTopic(topic.id)?.id).toBe(topic.id);

  expect(() => topicService.abortTurn(topic.id, member)).toThrow(TopicServiceError);
  await expect(topicService.reset({ topicId: topic.id, userId: member })).rejects.toMatchObject({
    code: "TOPIC_NOT_FOUND",
  });
});

test("topicService protects manager topics before deletion", async () => {
  const userId = `topic-service-manager-${randomUUID()}`;
  const topic = ensurePersonalGeneral(userId);

  await expect(topicService.delete({ topicId: topic.id, userId })).rejects.toMatchObject({
    code: "TOPIC_PROTECTED",
  });
  expect(getTopic(topic.id)).not.toBeNull();
});

test("topicService abort cancels a durable pending user turn and clears its activity", () => {
  const owner = `topic-service-abort-${randomUUID()}`;
  const topic = topicService.create({
    title: `Topic service abort ${randomUUID()}`,
    userId: owner,
    agent: "codex",
  });
  const requestId = enqueueRuntimeUserTurnRequest({
    topicId: topic.id,
    userId: owner,
    prompt: "queued while another process owns the topic",
    allowAutoContinue: true,
  });
  const initialEpoch = getRuntimeTopicEpoch(topic.id);
  const events: Array<{ kind?: string; queryId?: string; reason?: string }> = [];
  const unsubscribe = runtimeBus().subscribe((event) => {
    if (event.topicId === topic.id && event.type === "ai-status") {
      events.push(event.payload as (typeof events)[number]);
    }
  });

  try {
    expect(topicService.abortTurn(topic.id, owner)).toBe(true);
    expect(getRuntimeUserTurnRequest(topic.id)).toBeNull();
    expect(getRuntimeTopicEpoch(topic.id)).toBe(initialEpoch + 1);
    expect(events).toContainEqual({ kind: "ai_aborted", queryId: requestId, reason: "stopped" });

    const nextRequestId = enqueueRuntimeUserTurnRequest({
      topicId: topic.id,
      userId: owner,
      prompt: "new conversation after abort",
      allowAutoContinue: true,
    });
    expect(claimNextRuntimeUserTurnRequest("post-abort-worker")).toMatchObject({
      topicId: topic.id,
      requestId: nextRequestId,
      topicEpoch: initialEpoch + 1,
    });
    completeRuntimeUserTurnRequest(topic.id, nextRequestId);
  } finally {
    unsubscribe();
  }
});
