import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db, type TopicDto, upsertTopic } from "@negotium/core";
import { CronScheduler } from "../src/scheduler";
import {
  claimCronRuns,
  createCronJob,
  finalizeOrphanedCronRuns,
  finishCronRun,
  getCronJob,
  getCronTopicContext,
  getCronTopicSession,
  listCronRuns,
  listCronTopicSessions,
  markCronRunStarted,
  recoverPendingCronRuns,
  requestCronCancel,
  requestCronRun,
  setCronTopicSession,
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
  for (const id of topicIds.splice(0)) {
    db.query("DELETE FROM negotium_cron_topic_sessions WHERE topic_id = ?").run(id);
    db.query("DELETE FROM api_topics WHERE id = ?").run(id);
  }
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition was not met");
    await Bun.sleep(5);
  }
}

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
    setCronTopicSession(
      topic.id,
      topic.agent!,
      topic.participants[0]!.userId,
      "provider-session-1",
    );

    expect(getCronTopicSession(topic.id, topic.agent!)?.sessionId).toBe("provider-session-1");
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

  test("recovers pre-dispatch runs but finalizes runs with an unknown dispatched outcome", () => {
    const topic = createTopic();
    const pendingJob = createJob(topic);
    const runningJob = createJob(topic);
    requestCronRun(pendingJob.id, new Date("2026-07-14T12:01:00Z"));
    requestCronRun(runningJob.id, new Date("2026-07-14T12:01:01Z"));
    const claimed = claimCronRuns(new Date("2026-07-14T12:02:00Z"));
    const running = claimed.find((entry) => entry.job.id === runningJob.id)!;
    markCronRunStarted(running.run.id, "unknown-query", new Date("2026-07-14T12:02:01Z"));

    expect(finalizeOrphanedCronRuns(new Date("2026-07-14T12:03:00Z"))).toBe(1);
    expect(recoverPendingCronRuns().map((entry) => entry.job.id)).toEqual([pendingJob.id]);
    expect(listCronRuns(runningJob.id, 1)[0]).toMatchObject({
      status: "failed",
      error: "node restarted after dispatch; final outcome is unknown",
    });
    finishCronRun(claimed.find((entry) => entry.job.id === pendingJob.id)!.run.id, {
      status: "succeeded",
    });
  });
});

describe("cron scheduler", () => {
  test("dispatches through hooks and preserves a topic-owned provider session", async () => {
    const topic = createTopic();
    const job = createJob(topic);
    requestCronRun(job.id, new Date("2026-07-14T12:01:00Z"));
    const scheduler = new CronScheduler({
      now: () => new Date("2026-07-14T12:02:00Z"),
      dispatch(receivedJob, _run, hooks, context) {
        expect(receivedJob.id).toBe(job.id);
        expect(context.sessionName).toBe(`cron-${topic.id}`);
        hooks.onDispatched("cron-query-1");
        hooks.onSessionId("cron-session-1");
        hooks.onSettled({ queryId: "cron-query-1", kind: "completed" });
        return "cron-query-1";
      },
    });

    await scheduler.tick();
    await waitFor(() => listCronRuns(job.id, 1)[0]?.status === "succeeded");

    expect(getCronTopicSession(topic.id, "claude")?.sessionId).toBe("cron-session-1");
    expect(listCronRuns(job.id, 1)[0]).toMatchObject({
      source: "manual",
      status: "succeeded",
      queryId: "cron-query-1",
    });
  });

  test("serializes jobs by topic and gives the next job the previous job context", async () => {
    const topic = createTopic();
    const first = createJob(topic);
    const second = createJob(topic);
    requestCronRun(first.id, new Date("2026-07-14T12:01:00Z"));
    requestCronRun(second.id, new Date("2026-07-14T12:01:01Z"));
    const seen: Array<{ jobId: string; sessionId?: string; sessionName: string }> = [];
    const scheduler = new CronScheduler({
      now: () => new Date("2026-07-14T12:02:00Z"),
      dispatch(job, _run, hooks, context) {
        seen.push({
          jobId: job.id,
          sessionId: context.sessionId,
          sessionName: context.sessionName,
        });
        const n = seen.length;
        hooks.onDispatched(`cron-query-${n}`);
        hooks.onSessionId(`cron-session-${n}`);
        hooks.onSettled({ queryId: `cron-query-${n}`, kind: "completed" });
        return `cron-query-${n}`;
      },
    });

    await scheduler.tick();
    await waitFor(() => seen.length === 2);

    expect(seen).toEqual([
      { jobId: first.id, sessionId: undefined, sessionName: `cron-${topic.id}` },
      { jobId: second.id, sessionId: "cron-session-1", sessionName: `cron-${topic.id}` },
    ]);
    expect(listCronTopicSessions(topic.id)).toHaveLength(1);
    expect(getCronTopicSession(topic.id, "claude")?.sessionId).toBe("cron-session-2");
  });

  test("rotates one shared topic context after five successful runs", async () => {
    const topic = createTopic();
    const first = createJob(topic);
    const second = createJob(topic);
    for (let i = 0; i < 5; i++) requestCronRun(first.id);
    const seenSessionIds: Array<string | undefined> = [];
    let dispatchCount = 0;
    const scheduler = new CronScheduler({
      dispatch(_job, _run, hooks, context) {
        dispatchCount += 1;
        seenSessionIds.push(context.sessionId);
        const queryId = `rotation-query-${dispatchCount}`;
        hooks.onDispatched(queryId);
        hooks.onSessionId(`rotation-session-${dispatchCount}`);
        hooks.onSettled({ queryId, kind: "completed" });
        return queryId;
      },
    });

    await scheduler.tick();
    await waitFor(
      () =>
        dispatchCount === 5 &&
        getCronTopicContext(topic.id)?.successfulRunsSinceRotation === 0 &&
        getCronTopicSession(topic.id, "claude") === null,
    );

    expect(seenSessionIds).toEqual([
      undefined,
      "rotation-session-1",
      "rotation-session-2",
      "rotation-session-3",
      "rotation-session-4",
    ]);
    expect(getCronTopicContext(topic.id)?.lastRotatedAt).toBeDefined();

    requestCronRun(second.id);
    await scheduler.tick();
    await waitFor(() => dispatchCount === 6);

    expect(seenSessionIds[5]).toBeUndefined();
    expect(getCronTopicContext(topic.id)?.successfulRunsSinceRotation).toBe(1);
  });

  test("finishes an overdue durable rotation before dispatch after restart", async () => {
    const topic = createTopic();
    const job = createJob(topic);
    for (let i = 0; i < 5; i++) requestCronRun(job.id);
    const claimed = claimCronRuns(new Date());
    for (const entry of claimed) finishCronRun(entry.run.id, { status: "succeeded" });
    expect(getCronTopicContext(topic.id)?.successfulRunsSinceRotation).toBe(5);

    requestCronRun(job.id);
    let dispatched = false;
    let receivedSessionId: string | undefined;
    const scheduler = new CronScheduler({
      dispatch(_job, _run, hooks, context) {
        dispatched = true;
        receivedSessionId = context.sessionId;
        hooks.onDispatched("post-restart-query");
        hooks.onSettled({ queryId: "post-restart-query", kind: "completed" });
        return "post-restart-query";
      },
    });

    await scheduler.tick();
    await waitFor(() => dispatched);

    expect(receivedSessionId).toBeUndefined();
    expect(getCronTopicContext(topic.id)?.successfulRunsSinceRotation).toBe(1);
    expect(getCronTopicContext(topic.id)?.lastRotatedAt).toBeDefined();
  });

  test("cancels a deferred request and rejects late session writes on shutdown", async () => {
    const topic = createTopic();
    const job = createJob(topic);
    requestCronRun(job.id);
    let cancelled = false;
    let lateSession: ((sessionId: string) => void) | undefined;
    const scheduler = new CronScheduler({
      dispatch(_job, _run, hooks) {
        lateSession = hooks.onSessionId;
        return {
          status: "deferred",
          requestId: "cron-deferred",
          cancel: () => {
            cancelled = true;
            return true;
          },
        };
      },
    });

    await scheduler.tick();
    await waitFor(() => lateSession !== undefined);
    scheduler.stop();
    lateSession?.("too-late");

    expect(cancelled).toBe(true);
    expect(getCronTopicSession(topic.id, "claude")).toBeNull();
    expect(listCronRuns(job.id, 1)[0]).toMatchObject({ status: "aborted" });
  });

  test("processes durable cron_kill requests for active runs", async () => {
    const topic = createTopic();
    const job = createJob(topic);
    requestCronRun(job.id);
    let cancelCalled = false;
    let dispatchReady = false;
    const scheduler = new CronScheduler({
      dispatch() {
        dispatchReady = true;
        return {
          status: "deferred",
          requestId: "cron-kill-target",
          cancel: () => {
            cancelCalled = true;
            return true;
          },
        };
      },
    });

    await scheduler.tick();
    await waitFor(() => dispatchReady);
    requestCronCancel(job.id);
    await scheduler.tick();

    expect(cancelCalled).toBe(true);
    expect(listCronRuns(job.id, 1)[0]).toMatchObject({
      status: "aborted",
      error: "run cancelled by cron_kill",
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
    await waitFor(() => listCronRuns(job.id, 1)[0]?.status === "failed");

    expect(dispatched).toBe(false);
    expect(getCronJob(job.id)?.enabled).toBe(false);
    expect(listCronRuns(job.id, 1)[0]).toMatchObject({
      status: "failed",
      error: "job owner is no longer a topic participant; job disabled",
    });
  });
});
