import { randomUUID } from "node:crypto";
import { type AgentKind, db, type EffortLevel } from "@negotium/core";
import { computeNextCronRun, normalizeCronTimezone, parseCronExpression } from "#schedule";

export type CronRunStatus = "pending" | "running" | "succeeded" | "failed" | "aborted" | "skipped";

export interface CronJobRecord {
  id: string;
  name: string;
  ownerUserId: string;
  topicId: string;
  prompt: string;
  schedule: string;
  timezone?: string;
  enabled: boolean;
  agent?: AgentKind;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronRunRecord {
  id: string;
  jobId: string;
  source: "schedule" | "manual";
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: CronRunStatus;
  queryId?: string;
  durationMs?: number;
  outputPreview?: string;
  error?: string;
}

interface JobRow {
  id: string;
  name: string;
  owner_user_id: string;
  topic_id: string;
  prompt: string;
  schedule: string;
  timezone: string | null;
  enabled: number;
  agent: string | null;
  model: string | null;
  effort: string | null;
  session_id: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  job_id: string;
  source: "schedule" | "manual";
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: CronRunStatus;
  query_id: string | null;
  duration_ms: number | null;
  output_preview: string | null;
  error: string | null;
}

let schemaReady = false;

export function ensureCronSchema(): void {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS negotium_cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      timezone TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      agent TEXT,
      model TEXT,
      effort TEXT,
      session_id TEXT,
      next_run_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_negotium_cron_owner_name
      ON negotium_cron_jobs(owner_user_id, name);
    CREATE INDEX IF NOT EXISTS idx_negotium_cron_due
      ON negotium_cron_jobs(enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS negotium_cron_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES negotium_cron_jobs(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      status TEXT NOT NULL,
      query_id TEXT,
      duration_ms INTEGER,
      output_preview TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_negotium_cron_runs_job
      ON negotium_cron_runs(job_id, scheduled_at DESC);
    CREATE TABLE IF NOT EXISTS negotium_cron_requests (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES negotium_cron_jobs(id) ON DELETE CASCADE,
      requested_at TEXT NOT NULL
    );
  `);
  schemaReady = true;
}

function toJob(row: JobRow): CronJobRecord {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    topicId: row.topic_id,
    prompt: row.prompt,
    schedule: row.schedule,
    timezone: row.timezone ?? undefined,
    enabled: row.enabled !== 0,
    agent: (row.agent as AgentKind | null) ?? undefined,
    model: row.model ?? undefined,
    effort: (row.effort as EffortLevel | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): CronRunRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    source: row.source,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    status: row.status,
    queryId: row.query_id ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    outputPreview: row.output_preview ?? undefined,
    error: row.error ?? undefined,
  };
}

export function createCronJob(input: {
  name: string;
  ownerUserId: string;
  topicId: string;
  prompt: string;
  schedule: string;
  timezone?: string;
  agent?: AgentKind;
  model?: string;
  effort?: EffortLevel;
  now?: Date;
}): CronJobRecord {
  ensureCronSchema();
  parseCronExpression(input.schedule);
  const timezone = input.timezone ? normalizeCronTimezone(input.timezone) : undefined;
  if (input.timezone && !timezone) throw new Error(`invalid timezone: ${input.timezone}`);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const job: CronJobRecord = {
    id: randomUUID(),
    name: input.name,
    ownerUserId: input.ownerUserId,
    topicId: input.topicId,
    prompt: input.prompt,
    schedule: input.schedule.trim(),
    timezone,
    enabled: true,
    agent: input.agent,
    model: input.model,
    effort: input.effort,
    nextRunAt: computeNextCronRun(input.schedule, now, timezone).toISOString(),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  db.query(
    `INSERT INTO negotium_cron_jobs
      (id,name,owner_user_id,topic_id,prompt,schedule,timezone,enabled,agent,model,effort,session_id,next_run_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    job.id,
    job.name,
    job.ownerUserId,
    job.topicId,
    job.prompt,
    job.schedule,
    job.timezone ?? null,
    1,
    job.agent ?? null,
    job.model ?? null,
    job.effort ?? null,
    null,
    job.nextRunAt,
    job.createdAt,
    job.updatedAt,
  );
  return job;
}

export function listCronJobs(ownerUserId?: string): CronJobRecord[] {
  ensureCronSchema();
  const rows = ownerUserId
    ? db
        .query("SELECT * FROM negotium_cron_jobs WHERE owner_user_id = ? ORDER BY created_at DESC")
        .all(ownerUserId)
    : db.query("SELECT * FROM negotium_cron_jobs ORDER BY created_at DESC").all();
  return (rows as JobRow[]).map(toJob);
}

export function getCronJob(id: string): CronJobRecord | null {
  ensureCronSchema();
  const row = db.query("SELECT * FROM negotium_cron_jobs WHERE id = ?").get(id) as
    | JobRow
    | undefined;
  return row ? toJob(row) : null;
}

export function getCronJobByOwnerAndName(ownerUserId: string, name: string): CronJobRecord | null {
  ensureCronSchema();
  const row = db
    .query("SELECT * FROM negotium_cron_jobs WHERE owner_user_id = ? AND name = ?")
    .get(ownerUserId, name) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function setCronJobEnabled(
  id: string,
  enabled: boolean,
  now = new Date(),
): CronJobRecord | null {
  ensureCronSchema();
  const job = getCronJob(id);
  if (!job) return null;
  const nextRunAt = enabled
    ? computeNextCronRun(job.schedule, now, job.timezone).toISOString()
    : job.nextRunAt;
  db.query(
    "UPDATE negotium_cron_jobs SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
  ).run(enabled ? 1 : 0, nextRunAt, now.toISOString(), id);
  return getCronJob(id);
}

export function setCronJobSessionId(id: string, sessionId: string | null): void {
  ensureCronSchema();
  db.query("UPDATE negotium_cron_jobs SET session_id = ?, updated_at = ? WHERE id = ?").run(
    sessionId,
    new Date().toISOString(),
    id,
  );
}

export function deleteCronJob(id: string): boolean {
  ensureCronSchema();
  const result = db.query("DELETE FROM negotium_cron_jobs WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

export function requestCronRun(jobId: string, now = new Date()): string {
  ensureCronSchema();
  const id = randomUUID();
  db.query("INSERT INTO negotium_cron_requests (id,job_id,requested_at) VALUES (?,?,?)").run(
    id,
    jobId,
    now.toISOString(),
  );
  return id;
}

function insertRun(
  jobId: string,
  source: "schedule" | "manual",
  scheduledAt: string,
): CronRunRecord {
  const run: CronRunRecord = {
    id: randomUUID(),
    jobId,
    source,
    scheduledAt,
    status: "pending",
  };
  db.query(
    "INSERT INTO negotium_cron_runs (id,job_id,source,scheduled_at,status) VALUES (?,?,?,?,?)",
  ).run(run.id, run.jobId, run.source, run.scheduledAt, run.status);
  return run;
}

export function claimCronRuns(
  now = new Date(),
  limit = 20,
): Array<{ job: CronJobRecord; run: CronRunRecord }> {
  ensureCronSchema();
  const claimed: Array<{ job: CronJobRecord; run: CronRunRecord }> = [];
  db.transaction(() => {
    const requests = db
      .query(
        `SELECT r.id AS request_id, r.requested_at, j.*
         FROM negotium_cron_requests r JOIN negotium_cron_jobs j ON j.id = r.job_id
         ORDER BY r.requested_at LIMIT ?`,
      )
      .all(limit) as Array<JobRow & { request_id: string; requested_at: string }>;
    for (const row of requests) {
      db.query("DELETE FROM negotium_cron_requests WHERE id = ?").run(row.request_id);
      claimed.push({ job: toJob(row), run: insertRun(row.id, "manual", row.requested_at) });
    }

    const remaining = Math.max(0, limit - claimed.length);
    if (remaining === 0) return;
    const due = db
      .query(
        `SELECT * FROM negotium_cron_jobs
         WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`,
      )
      .all(now.toISOString(), remaining) as JobRow[];
    for (const row of due) {
      const job = toJob(row);
      const run = insertRun(job.id, "schedule", job.nextRunAt);
      const nextRunAt = computeNextCronRun(job.schedule, now, job.timezone).toISOString();
      db.query("UPDATE negotium_cron_jobs SET next_run_at = ?, updated_at = ? WHERE id = ?").run(
        nextRunAt,
        now.toISOString(),
        job.id,
      );
      claimed.push({ job: { ...job, nextRunAt }, run });
    }
  })();
  return claimed;
}

export function markCronRunStarted(runId: string, queryId: string, now = new Date()): void {
  ensureCronSchema();
  db.query(
    "UPDATE negotium_cron_runs SET status = 'running', query_id = ?, started_at = ? WHERE id = ?",
  ).run(queryId, now.toISOString(), runId);
}

export function finishCronRun(
  runId: string,
  result: {
    status: Exclude<CronRunStatus, "pending" | "running">;
    outputPreview?: string;
    error?: string;
  },
  now = new Date(),
): void {
  ensureCronSchema();
  const row = db.query("SELECT started_at FROM negotium_cron_runs WHERE id = ?").get(runId) as
    | { started_at: string | null }
    | undefined;
  const durationMs = row?.started_at
    ? Math.max(0, now.getTime() - Date.parse(row.started_at))
    : null;
  db.query(
    `UPDATE negotium_cron_runs
     SET status = ?, finished_at = ?, duration_ms = ?, output_preview = ?, error = ? WHERE id = ?`,
  ).run(
    result.status,
    now.toISOString(),
    durationMs,
    result.outputPreview?.slice(0, 500) ?? null,
    result.error ?? null,
    runId,
  );
}

export function listCronRuns(jobId: string, limit = 20): CronRunRecord[] {
  ensureCronSchema();
  return (
    db
      .query("SELECT * FROM negotium_cron_runs WHERE job_id = ? ORDER BY scheduled_at DESC LIMIT ?")
      .all(jobId, limit) as RunRow[]
  ).map(toRun);
}

export function finalizeOrphanedCronRuns(now = new Date()): number {
  ensureCronSchema();
  const result = db
    .query(
      `UPDATE negotium_cron_runs
       SET status = 'failed', finished_at = ?, error = 'node restarted before run completed'
       WHERE status IN ('pending','running')`,
    )
    .run(now.toISOString());
  return Number(result.changes);
}
