import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db, type TopicDto, upsertTopic } from "@negotium/core";
import { createCronJob, getCronJob } from "../src/store";
import { cleanCronPromptSummary, queueCronPromptSummary } from "../src/summarize";

const topicIds: string[] = [];
const jobIds: string[] = [];

function createPromptJob(prompt: string) {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `cron-summary-topic-${randomUUID()}`,
    title: `Cron summary ${randomUUID()}`,
    kind: "agent",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId: "summary-owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  };
  upsertTopic(topic);
  topicIds.push(topic.id);
  const job = createCronJob({
    name: `summary-${randomUUID()}`,
    ownerUserId: "summary-owner",
    topicId: topic.id,
    prompt,
    schedule: "0 9 * * *",
  });
  jobIds.push(job.id);
  return job;
}

afterEach(() => {
  for (const id of jobIds.splice(0))
    db.query("DELETE FROM negotium_cron_jobs WHERE id = ?").run(id);
  for (const id of topicIds.splice(0)) db.query("DELETE FROM api_topics WHERE id = ?").run(id);
});

describe("cron prompt summaries", () => {
  test("cleans labels and enforces the stored label limit", () => {
    expect(cleanCronPromptSummary('Summary: "Daily project report."')).toBe("Daily project report");
    expect(cleanCronPromptSummary("x".repeat(80))?.length).toBe(60);
  });

  test("only persists a generated summary while the source prompt still matches", async () => {
    const job = createPromptJob("Original prompt");
    queueCronPromptSummary(job.id, job.prompt!, async () => {
      await Bun.sleep(10);
      return "Original label";
    });
    db.query("UPDATE negotium_cron_jobs SET prompt = ? WHERE id = ?").run("Changed prompt", job.id);
    await Bun.sleep(30);
    expect(getCronJob(job.id)?.summary).toBeUndefined();
  });
});
