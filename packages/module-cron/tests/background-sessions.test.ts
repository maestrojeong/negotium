import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  claimRuntimeTurnLease,
  db,
  releaseRuntimeTurnLease,
  type TopicDto,
  upsertTopic,
} from "@negotium/core";
import { listCronBackgroundSessions } from "../src/background-sessions";
import { createCronJob } from "../src/store";

const topicIds: string[] = [];
const jobIds: string[] = [];

function fixture() {
  const ownerUserId = `owner-${randomUUID()}`;
  const now = new Date("2026-07-17T12:00:00.000Z");
  const topic: TopicDto = {
    id: `topic-${randomUUID()}`,
    title: "Daily operations",
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId: ownerUserId, role: "owner" }],
    createdAt: now.toISOString(),
    lastMessageAt: now.toISOString(),
  };
  upsertTopic(topic);
  topicIds.push(topic.id);
  const job = createCronJob({
    name: "daily-digest",
    ownerUserId,
    topicId: topic.id,
    prompt: "Summarize today's operational changes.",
    schedule: "0 9 * * *",
    timezone: "UTC",
    model: "gpt-5.6-terra",
    effort: "high",
    now,
  });
  jobIds.push(job.id);
  return { job, ownerUserId, topic };
}

afterEach(() => {
  for (const id of jobIds.splice(0)) {
    db.query("DELETE FROM negotium_cron_jobs WHERE id = ?").run(id);
  }
  for (const id of topicIds.splice(0)) {
    db.query("DELETE FROM api_topics WHERE id = ?").run(id);
  }
});

describe("Cron background sessions", () => {
  test("keeps one topic-scoped session visible between runs", () => {
    const { job, ownerUserId, topic } = fixture();

    expect(listCronBackgroundSessions(ownerUserId)).toEqual([
      expect.objectContaining({
        id: `cron:${topic.id}`,
        topicId: topic.id,
        active: false,
        status: "Scheduled",
        model: "gpt-5.6-terra",
        effort: "high",
        prompt: job.prompt,
        promptTitle: `Prompt · ${job.name}`,
      }),
    ]);
  });

  test("reuses the stable topic session id while a run is active", () => {
    const { job, ownerUserId, topic } = fixture();
    const queryId = randomUUID();
    claimRuntimeTurnLease({
      topicId: topic.id,
      queryId,
      origin: `cron:${job.id}:${randomUUID()}`,
    });
    try {
      expect(listCronBackgroundSessions(ownerUserId)).toEqual([
        expect.objectContaining({
          id: `cron:${topic.id}`,
          active: true,
          status: "Running",
        }),
      ]);
    } finally {
      releaseRuntimeTurnLease(topic.id, queryId);
    }
  });
});
