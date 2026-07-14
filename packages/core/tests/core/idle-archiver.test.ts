import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cancelIdleArchiveForTopic,
  idleArchiveDelayMs,
  scheduleIdleArchiveForTopic,
} from "#agents/idle-archiver";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import type { TopicDto } from "#types/api";

const ORIGINAL_DELAY = process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS;
const createdTopicIds: string[] = [];

function makeTopic(aiMention: boolean): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `idle-archiver-${randomUUID()}`,
    title: `Idle Archiver ${randomUUID()}`,
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMention,
    participants: [{ userId: "idle-owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

afterEach(() => {
  if (ORIGINAL_DELAY === undefined) {
    delete process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS;
  } else {
    process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS = ORIGINAL_DELAY;
  }
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

describe("idle archiver defaults", () => {
  test("defaults to 6 hours before archiving an idle topic", () => {
    delete process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS;

    expect(idleArchiveDelayMs()).toBe(6 * 60 * 60 * 1000);
  });

  test("NEGOTIUM_IDLE_ARCHIVE_DELAY_MS overrides the default", () => {
    process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS = "12345";

    expect(idleArchiveDelayMs()).toBe(12345);
  });

  test("does not schedule memory archive for mention-only channels", () => {
    const topic = makeTopic(true);

    expect(scheduleIdleArchiveForTopic(topic.id, "idle-owner")).toBe("mention-only-channel");
  });

  test("schedules memory archive for always-respond agent rooms", () => {
    const topic = makeTopic(false);

    expect(scheduleIdleArchiveForTopic(topic.id, "idle-owner")).toBe("scheduled");
    expect(cancelIdleArchiveForTopic(topic.id)).toBe(true);
    expect(cancelIdleArchiveForTopic(topic.id)).toBe(false);
  });
});
