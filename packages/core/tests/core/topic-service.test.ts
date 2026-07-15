import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ensurePersonalGeneral, getTopic, TopicServiceError, topicService } from "@negotium/core";

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
