import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db, type TopicDto, upsertTopic } from "@negotium/core";
import { CronScheduler } from "../src/scheduler";
import {
  claimCronRuns,
  createCronJob,
  finishCronRun,
  getCronJob,
  listCronRuns,
  markCronRunStarted,
  requestCronRun,
  setCronJobSessionId,
} from "../src/store";

const topicIds: string[] = [];
const jobIds: string[] = [];

function createTopic(ownerUserId = "cron-owner"): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `cron-topic-${randomUUID()}`,
    title: `Cron ${randomUUID()}`,
    kind: "agent",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId: ownerUserId, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  };
  upsertTopic(topic);
  topicIds.push(topic.id);
  return topic;
}

function createJob(topic: TopicDto, now = new Date("2026-07-14T12:00:00Z")) {
  const job = createCronJob({
    name: `job-${randomUUID()}`,
    ownerUserId: topic.participants[0]!.userId,
    topicId: topic.id,
    prompt: "Summarize the project status",
    schedule: "0 9 * * *",
    timezone: "UTC",
    now,
  });
  jobIds.push(job.id);
  return job;
}

afterEach(() => {
  for (const id of jobIds.splice(0))
    db.query("DELETE FROM negotium_cron_jobs WHERE id = ?").run(id);
  for (const id of topicIds.splice(0)) db.query("DELETE FROM api_topics WHERE id = ?").run(id);
});

describe("cron store", () => {
  test("uses the due-time index for idle scheduler polling", () => {
    const topic = createTopic();
    createJob(topic);
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT * FROM negotium_cron_jobs
         WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`,
      )
      .all(new Date().toISOString(), 20) as Array<{ detail: string }>;

    expect(plan.some((row) => row.detail.includes("idx_negotium_cron_due"))).toBe(true);
  });

  test("claims a durable manual request and records its lifecycle", () => {
    const topic = createTopic();
    const job = createJob(topic);
    requestCronRun(job.id, new Date("2026-07-14T12:01:00Z"));

    const claimed = claimCronRuns(new Date("2026-07-14T12:02:00Z"));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.run).toMatchObject({ jobId: job.id, source: "manual", status: "pending" });

    markCronRunStarted(claimed[0]!.run.id, "query-1", new Date("2026-07-14T12:02:01Z"));
    finishCronRun(
      claimed[0]!.run.id,
      { status: "succeeded", outputPreview: "done" },
      new Date("2026-07-14T12:02:04Z"),
    );
    setCronJobSessionId(job.id, "provider-session-1");

    expect(getCronJob(job.id)?.sessionId).toBe("provider-session-1");
    expect(listCronRuns(job.id, 1)[0]).toMatchObject({
      status: "succeeded",
      queryId: "query-1",
      durationMs: 3_000,
      outputPreview: "done",
    });
  });

  test("advances next_run_at when a scheduled run is claimed", () => {
    const topic = createTopic();
    const job = createCronJob({
      name: `due-${randomUUID()}`,
      ownerUserId: topic.participants[0]!.userId,
      topicId: topic.id,
      prompt: "Run once",
      schedule: "* * * * *",
      timezone: "UTC",
      now: new Date("2026-07-14T12:00:00Z"),
    });
    jobIds.push(job.id);

    const claimed = claimCronRuns(new Date("2026-07-14T12:01:00Z"));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.run.source).toBe("schedule");
    expect(getCronJob(job.id)?.nextRunAt).toBe("2026-07-14T12:02:00.000Z");
    finishCronRun(claimed[0]!.run.id, { status: "succeeded" });
  });
});

describe("cron scheduler", () => {
  test("dispatches through hooks and preserves an isolated provider session", async () => {
    const topic = createTopic();
    const job = createJob(topic);
    requestCronRun(job.id, new Date("2026-07-14T12:01:00Z"));
    const scheduler = new CronScheduler({
      now: () => new Date("2026-07-14T12:02:00Z"),
      dispatch(receivedJob, _run, hooks) {
        expect(receivedJob.id).toBe(job.id);
        hooks.onDispatched("cron-query-1");
        hooks.onSessionId("cron-session-1");
        hooks.onSettled({ queryId: "cron-query-1", kind: "completed" });
        return "cron-query-1";
      },
    });

    await scheduler.tick();

    expect(getCronJob(job.id)?.sessionId).toBe("cron-session-1");
    expect(listCronRuns(job.id, 1)[0]).toMatchObject({
      source: "manual",
      status: "succeeded",
      queryId: "cron-query-1",
    });
  });

  test("disables a job whose owner lost topic membership", async () => {
    const topic = createTopic("other-owner");
    const job = createCronJob({
      name: `unowned-${randomUUID()}`,
      ownerUserId: "former-owner",
      topicId: topic.id,
      prompt: "Should not run",
      schedule: "0 9 * * *",
      timezone: "UTC",
      now: new Date("2026-07-14T12:00:00Z"),
    });
    jobIds.push(job.id);
    requestCronRun(job.id);
    let dispatched = false;
    const scheduler = new CronScheduler({
      dispatch() {
        dispatched = true;
        return null;
      },
    });

    await scheduler.tick();

    expect(dispatched).toBe(false);
    expect(getCronJob(job.id)?.enabled).toBe(false);
    expect(listCronRuns(job.id, 1)[0]).toMatchObject({
      status: "failed",
      error: "job owner is no longer a topic participant; job disabled",
    });
  });
});
