import { randomUUID } from "node:crypto";
import { type AgentKind, db as defaultDb, type EffortLevel } from "@negotium/core";
import { computeNextCronRun, normalizeCronTimezone, parseCronExpression } from "#schedule";
import { validateCronScriptName } from "#scripts";

export type CronRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "skipped"
  | "interrupted";

export interface CronJobRecord {
  id: string;
  name: string;
  ownerUserId: string;
  topicId: string;
  prompt?: string;
  script?: string;
  /** Short human label for a prompt job, generated asynchronously. */
  summary?: string;
  schedule: string;
  timezone?: string;
  enabled: boolean;
  agent?: AgentKind;
  model?: string;
  effort?: EffortLevel;
  /** @deprecated Session ownership is topic-scoped; use getCronTopicSession(). */
  sessionId?: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobPatch {
  name?: string;
  topicId?: string;
  prompt?: string | null;
  script?: string | null;
  summary?: string | null;
  schedule?: string;
  timezone?: string | null;
  enabled?: boolean;
  agent?: AgentKind | null;
  model?: string | null;
  effort?: EffortLevel | null;
}

export interface CronTopicSessionRecord {
  topicId: string;
  agent: AgentKind;
  ownerUserId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronTopicContextRecord {
  topicId: string;
  successfulRunsSinceRotation: number;
  lastRotatedAt?: string;
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
  exitCode?: number;
}

interface JobRow {
  id: string;
  name: string;
  owner_user_id: string;
  topic_id: string;
  prompt: string;
  script: string | null;
  summary: string | null;
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
  exit_code: number | null;
  topic_id: string | null;
}

interface TopicSessionRow {
  topic_id: string;
  agent: string;
  owner_user_id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
}

interface TopicContextRow {
  topic_id: string;
  successful_runs_since_rotation: number;
  last_rotated_at: string | null;
  updated_at: string;
}

interface TableColumnRow {
  name: string;
}

let schemaReady = false;

export type CronDatabase = Pick<typeof defaultDb, "exec" | "query" | "transaction">;

let db: CronDatabase = defaultDb;

/** Replace the cron persistence handle for an embedding host. */
export function configureCronDatabase(database: CronDatabase): () => void {
  const previous = db;
  db = database;
  schemaReady = false;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    db = previous;
    schemaReady = false;
  };
}

export function ensureCronSchema(): void {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS negotium_cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      script TEXT,
      summary TEXT,
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
      error TEXT,
      exit_code INTEGER,
      topic_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_negotium_cron_runs_job
      ON negotium_cron_runs(job_id, scheduled_at DESC);
    CREATE TABLE IF NOT EXISTS negotium_cron_requests (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES negotium_cron_jobs(id) ON DELETE CASCADE,
      requested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS negotium_cron_cancellations (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES negotium_cron_jobs(id) ON DELETE CASCADE,
      requested_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS negotium_cron_topic_sessions (
      topic_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (topic_id, agent)
    );
    CREATE INDEX IF NOT EXISTS idx_negotium_cron_topic_sessions_owner
      ON negotium_cron_topic_sessions(owner_user_id, topic_id);
    CREATE TABLE IF NOT EXISTS negotium_cron_topic_context (
      topic_id TEXT PRIMARY KEY REFERENCES api_topics(id) ON DELETE CASCADE,
      successful_runs_since_rotation INTEGER NOT NULL DEFAULT 0,
      last_rotated_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const jobColumns = new Set(
    (db.query("PRAGMA table_info(negotium_cron_jobs)").all() as TableColumnRow[]).map(
      (column) => column.name,
    ),
  );
  if (!jobColumns.has("script")) {
    db.exec("ALTER TABLE negotium_cron_jobs ADD COLUMN script TEXT");
  }
  if (!jobColumns.has("summary")) {
    db.exec("ALTER TABLE negotium_cron_jobs ADD COLUMN summary TEXT");
  }
  const runColumns = new Set(
    (db.query("PRAGMA table_info(negotium_cron_runs)").all() as TableColumnRow[]).map(
      (column) => column.name,
    ),
  );
  if (!runColumns.has("exit_code")) {
    db.exec("ALTER TABLE negotium_cron_runs ADD COLUMN exit_code INTEGER");
  }
  if (!runColumns.has("topic_id")) {
    db.exec("ALTER TABLE negotium_cron_runs ADD COLUMN topic_id TEXT");
  }

  // One-time best-effort promotion from the old job-owned session model.
  // Rows are processed oldest-to-newest so the most recently updated job wins
  // when several legacy jobs targeted the same topic and provider.
  const legacySessions = db
    .query(
      `SELECT j.topic_id, COALESCE(j.agent, t.agent) AS agent,
              j.owner_user_id, j.session_id, j.created_at, j.updated_at
       FROM negotium_cron_jobs j
       LEFT JOIN api_topics t ON t.id = j.topic_id
       WHERE j.session_id IS NOT NULL AND COALESCE(j.agent, t.agent) IS NOT NULL
       ORDER BY j.updated_at ASC`,
    )
    .all() as TopicSessionRow[];
  for (const legacy of legacySessions) {
    db.query(
      `INSERT INTO negotium_cron_topic_sessions
         (topic_id,agent,owner_user_id,session_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(topic_id,agent) DO UPDATE SET
         owner_user_id = excluded.owner_user_id,
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    ).run(
      legacy.topic_id,
      legacy.agent,
      legacy.owner_user_id,
      legacy.session_id,
      legacy.created_at,
      legacy.updated_at,
    );
  }
  if (legacySessions.length > 0) {
    db.query("UPDATE negotium_cron_jobs SET session_id = NULL WHERE session_id IS NOT NULL").run();
  }
  schemaReady = true;
}

function toJob(row: JobRow): CronJobRecord {
  const topicAgent = row.agent
    ? row.agent
    : (
        db.query("SELECT agent FROM api_topics WHERE id = ?").get(row.topic_id) as
          | { agent: string | null }
          | undefined
      )?.agent;
  const topicSession = topicAgent
    ? (db
        .query(
          "SELECT session_id FROM negotium_cron_topic_sessions WHERE topic_id = ? AND agent = ?",
        )
        .get(row.topic_id, topicAgent) as { session_id: string } | undefined)
    : undefined;
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    topicId: row.topic_id,
    prompt: row.prompt.trim() || undefined,
    script: row.script?.trim() || undefined,
    summary: row.summary?.trim() || undefined,
    schedule: row.schedule,
    timezone: row.timezone ?? undefined,
    enabled: row.enabled !== 0,
    agent: (row.agent as AgentKind | null) ?? undefined,
    model: row.model ?? undefined,
    effort: (row.effort as EffortLevel | null) ?? undefined,
    sessionId: topicSession?.session_id,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTopicSession(row: TopicSessionRow): CronTopicSessionRecord {
  return {
    topicId: row.topic_id,
    agent: row.agent as AgentKind,
    ownerUserId: row.owner_user_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTopicContext(row: TopicContextRow): CronTopicContextRecord {
  return {
    topicId: row.topic_id,
    successfulRunsSinceRotation: row.successful_runs_since_rotation,
    lastRotatedAt: row.last_rotated_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function cronTopicSessionName(topicId: string): string {
  return `cron-${topicId}`;
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
    exitCode: row.exit_code ?? undefined,
  };
}

export function createCronJob(input: {
  name: string;
  ownerUserId: string;
  topicId: string;
  prompt?: string;
  script?: string;
  schedule: string;
  timezone?: string;
  agent?: AgentKind;
  model?: string;
  effort?: EffortLevel;
  summary?: string;
  now?: Date;
}): CronJobRecord {
  ensureCronSchema();
  const prompt = input.prompt?.trim() || undefined;
  const script = input.script?.trim() || undefined;
  if (Boolean(prompt) === Boolean(script)) {
    throw new Error("cron job requires exactly one of prompt or script");
  }
  if (script) {
    const valid = validateCronScriptName(script);
    if (!valid.ok) throw new Error(valid.error);
  }
  const otherOwner = db
    .query(
      `SELECT owner_user_id
       FROM negotium_cron_jobs
       WHERE topic_id = ? AND owner_user_id <> ?
       LIMIT 1`,
    )
    .get(input.topicId, input.ownerUserId) as { owner_user_id: string } | undefined;
  if (otherOwner) {
    throw new Error(
      `topic cron context is already owned by ${otherOwner.owner_user_id}; ` +
        "all cron jobs in one topic must share one owner",
    );
  }
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
    prompt,
    script,
    summary: input.summary?.trim() || undefined,
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
      (id,name,owner_user_id,topic_id,prompt,script,summary,schedule,timezone,enabled,agent,model,effort,session_id,next_run_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    job.id,
    job.name,
    job.ownerUserId,
    job.topicId,
    job.prompt ?? "",
    job.script ?? null,
    job.summary ?? null,
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

export function listEnabledCronJobs(): CronJobRecord[] {
  ensureCronSchema();
  return (
    db
      .query("SELECT * FROM negotium_cron_jobs WHERE enabled = 1 ORDER BY created_at DESC")
      .all() as JobRow[]
  ).map(toJob);
}

export function listCronJobsForTopic(topicId: string): CronJobRecord[] {
  ensureCronSchema();
  return (
    db
      .query("SELECT * FROM negotium_cron_jobs WHERE topic_id = ? ORDER BY created_at DESC")
      .all(topicId) as JobRow[]
  ).map(toJob);
}

export function listCronJobsForTopicOwner(topicId: string, ownerUserId: string): CronJobRecord[] {
  ensureCronSchema();
  return (
    db
      .query(
        "SELECT * FROM negotium_cron_jobs WHERE topic_id = ? AND owner_user_id = ? ORDER BY created_at DESC",
      )
      .all(topicId, ownerUserId) as JobRow[]
  ).map(toJob);
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

export function cronJobPatchChangesContext(job: CronJobRecord, patch: CronJobPatch): boolean {
  return (
    (patch.topicId !== undefined && patch.topicId !== job.topicId) ||
    (patch.prompt !== undefined && (patch.prompt?.trim() || undefined) !== job.prompt) ||
    (patch.script !== undefined && (patch.script?.trim() || undefined) !== job.script) ||
    (patch.agent !== undefined && (patch.agent ?? undefined) !== job.agent) ||
    (patch.model !== undefined && (patch.model?.trim() || undefined) !== job.model) ||
    (patch.effort !== undefined && (patch.effort ?? undefined) !== job.effort)
  );
}

export function updateCronJob(
  id: string,
  patch: CronJobPatch,
  now = new Date(),
): CronJobRecord | null {
  ensureCronSchema();
  const job = getCronJob(id);
  if (!job) return null;
  if (Object.values(patch).every((value) => value === undefined)) return job;

  const nextName = patch.name !== undefined ? patch.name.trim() : job.name;
  if (!/^[A-Za-z0-9_-]+$/.test(nextName)) {
    throw new Error("name must use only letters, numbers, dashes, and underscores");
  }

  const nextPrompt = patch.prompt !== undefined ? patch.prompt?.trim() || undefined : job.prompt;
  const nextScript = patch.script !== undefined ? patch.script?.trim() || undefined : job.script;
  if (Boolean(nextPrompt) === Boolean(nextScript)) {
    throw new Error("cron job requires exactly one of prompt or script");
  }
  if (nextScript) {
    const valid = validateCronScriptName(nextScript);
    if (!valid.ok) throw new Error(valid.error);
  }
  const nextSchedule = patch.schedule?.trim() ?? job.schedule;
  parseCronExpression(nextSchedule);
  const rawTimezone =
    patch.timezone !== undefined ? patch.timezone?.trim() || undefined : job.timezone;
  const nextTimezone = rawTimezone ? normalizeCronTimezone(rawTimezone) : undefined;
  if (rawTimezone && !nextTimezone) throw new Error(`invalid timezone: ${rawTimezone}`);
  const nextTopicId = patch.topicId?.trim() || job.topicId;
  const otherOwner = db
    .query(
      `SELECT owner_user_id FROM negotium_cron_jobs
       WHERE topic_id = ? AND owner_user_id <> ? AND id <> ? LIMIT 1`,
    )
    .get(nextTopicId, job.ownerUserId, id) as { owner_user_id: string } | undefined;
  if (otherOwner) {
    throw new Error(
      `topic cron context is already owned by ${otherOwner.owner_user_id}; ` +
        "all cron jobs in one topic must share one owner",
    );
  }

  const enabled = patch.enabled ?? job.enabled;
  const scheduleChanged = nextSchedule !== job.schedule || nextTimezone !== job.timezone;
  const nextRunAt =
    enabled && (scheduleChanged || (!job.enabled && enabled))
      ? computeNextCronRun(nextSchedule, now, nextTimezone).toISOString()
      : job.nextRunAt;
  const timestamp = now.toISOString();
  const sessionSensitiveChanged = cronJobPatchChangesContext(job, patch);
  if (sessionSensitiveChanged) {
    const active = db
      .query(
        "SELECT 1 FROM negotium_cron_runs WHERE job_id = ? AND status IN ('pending','running') LIMIT 1",
      )
      .get(id);
    if (active) {
      throw new Error("cannot change Cron context while a run is active; cancel it first");
    }
  }

  db.transaction(() => {
    db.query(
      `UPDATE negotium_cron_jobs SET
         name = ?, topic_id = ?, prompt = ?, script = ?, summary = ?, schedule = ?, timezone = ?,
         enabled = ?, agent = ?, model = ?, effort = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      nextName,
      nextTopicId,
      nextPrompt ?? "",
      nextScript ?? null,
      patch.summary !== undefined ? patch.summary?.trim() || null : (job.summary ?? null),
      nextSchedule,
      nextTimezone ?? null,
      enabled ? 1 : 0,
      patch.agent !== undefined ? patch.agent : (job.agent ?? null),
      patch.model !== undefined ? patch.model?.trim() || null : (job.model ?? null),
      patch.effort !== undefined ? patch.effort : (job.effort ?? null),
      nextRunAt,
      timestamp,
      id,
    );
  })();
  return getCronJob(id);
}

export function updateCronJobSummaryIfPromptMatches(
  id: string,
  expectedPrompt: string,
  summary: string,
): boolean {
  ensureCronSchema();
  const result = db
    .query("UPDATE negotium_cron_jobs SET summary = ? WHERE id = ? AND prompt = ?")
    .run(summary.trim(), id, expectedPrompt.trim());
  return Number(result.changes) > 0;
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
  const job = getCronJob(id);
  if (!job) return;
  const topic = db.query("SELECT agent FROM api_topics WHERE id = ?").get(job.topicId) as
    | { agent: string | null }
    | undefined;
  const agent = job.agent ?? (topic?.agent as AgentKind | null | undefined);
  if (!agent) return;
  if (sessionId) setCronTopicSession(job.topicId, agent, job.ownerUserId, sessionId);
  else resetCronTopicSessions(job.topicId);
}

export function getCronTopicSession(
  topicId: string,
  agent: AgentKind,
): CronTopicSessionRecord | null {
  ensureCronSchema();
  const row = db
    .query("SELECT * FROM negotium_cron_topic_sessions WHERE topic_id = ? AND agent = ?")
    .get(topicId, agent) as TopicSessionRow | undefined;
  return row ? toTopicSession(row) : null;
}

export function listCronTopicSessions(topicId: string): CronTopicSessionRecord[] {
  ensureCronSchema();
  return (
    db
      .query("SELECT * FROM negotium_cron_topic_sessions WHERE topic_id = ? ORDER BY agent")
      .all(topicId) as TopicSessionRow[]
  ).map(toTopicSession);
}

export function setCronTopicSession(
  topicId: string,
  agent: AgentKind,
  ownerUserId: string,
  sessionId: string,
  now = new Date(),
): CronTopicSessionRecord {
  ensureCronSchema();
  const timestamp = now.toISOString();
  db.query(
    `INSERT INTO negotium_cron_topic_sessions
       (topic_id,agent,owner_user_id,session_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(topic_id,agent) DO UPDATE SET
       owner_user_id = excluded.owner_user_id,
       session_id = excluded.session_id,
       updated_at = excluded.updated_at`,
  ).run(topicId, agent, ownerUserId, sessionId, timestamp, timestamp);
  return getCronTopicSession(topicId, agent)!;
}

export function setCronTopicSessionIfJobUpdatedAt(
  jobId: string,
  expectedJobUpdatedAt: string,
  topicId: string,
  agent: AgentKind,
  ownerUserId: string,
  sessionId: string,
  now = new Date(),
): CronTopicSessionRecord | null {
  ensureCronSchema();
  let updated = false;
  db.transaction(() => {
    const current = db
      .query("SELECT topic_id, updated_at FROM negotium_cron_jobs WHERE id = ?")
      .get(jobId) as { topic_id: string; updated_at: string } | undefined;
    if (!current || current.topic_id !== topicId || current.updated_at !== expectedJobUpdatedAt)
      return;
    setCronTopicSession(topicId, agent, ownerUserId, sessionId, now);
    updated = true;
  })();
  return updated ? getCronTopicSession(topicId, agent) : null;
}

export function clearCronTopicSession(topicId: string, agent: AgentKind): boolean {
  ensureCronSchema();
  const result = db
    .query("DELETE FROM negotium_cron_topic_sessions WHERE topic_id = ? AND agent = ?")
    .run(topicId, agent);
  return Number(result.changes) > 0;
}

export function resetCronTopicSessions(topicId: string): CronTopicSessionRecord[] {
  ensureCronSchema();
  const sessions = listCronTopicSessions(topicId);
  db.query("DELETE FROM negotium_cron_topic_sessions WHERE topic_id = ?").run(topicId);
  return sessions;
}

export function getCronTopicContext(topicId: string): CronTopicContextRecord | null {
  ensureCronSchema();
  const row = db
    .query("SELECT * FROM negotium_cron_topic_context WHERE topic_id = ?")
    .get(topicId) as TopicContextRow | undefined;
  return row ? toTopicContext(row) : null;
}

function incrementCronTopicSuccess(topicId: string, now: Date): number {
  const timestamp = now.toISOString();
  db.query(
    `INSERT INTO negotium_cron_topic_context
       (topic_id,successful_runs_since_rotation,last_rotated_at,updated_at)
     VALUES (?,1,NULL,?)
     ON CONFLICT(topic_id) DO UPDATE SET
       successful_runs_since_rotation = successful_runs_since_rotation + 1,
       updated_at = excluded.updated_at`,
  ).run(topicId, timestamp);
  return getCronTopicContext(topicId)!.successfulRunsSinceRotation;
}

export function markCronTopicContextRotated(topicId: string, now = new Date()): void {
  ensureCronSchema();
  const timestamp = now.toISOString();
  db.query(
    `INSERT INTO negotium_cron_topic_context
       (topic_id,successful_runs_since_rotation,last_rotated_at,updated_at)
     VALUES (?,0,?,?)
     ON CONFLICT(topic_id) DO UPDATE SET
       successful_runs_since_rotation = 0,
       last_rotated_at = excluded.last_rotated_at,
       updated_at = excluded.updated_at`,
  ).run(topicId, timestamp, timestamp);
}

export function resetCronTopicContextState(topicId: string): boolean {
  ensureCronSchema();
  const result = db
    .query("DELETE FROM negotium_cron_topic_context WHERE topic_id = ?")
    .run(topicId);
  return Number(result.changes) > 0;
}

export function listOrphanedCronTopicSessions(): CronTopicSessionRecord[] {
  ensureCronSchema();
  return (
    db
      .query(
        `SELECT s.* FROM negotium_cron_topic_sessions s
         LEFT JOIN api_topics t ON t.id = s.topic_id
         WHERE t.id IS NULL
         ORDER BY s.topic_id, s.agent`,
      )
      .all() as TopicSessionRow[]
  ).map(toTopicSession);
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

export function requestCronCancel(jobId: string, now = new Date()): string {
  ensureCronSchema();
  const id = randomUUID();
  db.query("INSERT INTO negotium_cron_cancellations (id,job_id,requested_at) VALUES (?,?,?)").run(
    id,
    jobId,
    now.toISOString(),
  );
  return id;
}

export function claimCronCancellations(limit = 100): string[] {
  ensureCronSchema();
  const jobIds: string[] = [];
  db.transaction(() => {
    const rows = db
      .query(
        `SELECT id, job_id FROM negotium_cron_cancellations
         ORDER BY requested_at LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; job_id: string }>;
    for (const row of rows) {
      db.query("DELETE FROM negotium_cron_cancellations WHERE id = ?").run(row.id);
      if (!jobIds.includes(row.job_id)) jobIds.push(row.job_id);
    }
  })();
  return jobIds;
}

function insertRun(
  jobId: string,
  topicId: string,
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
    "INSERT INTO negotium_cron_runs (id,job_id,topic_id,source,scheduled_at,status) VALUES (?,?,?,?,?,?)",
  ).run(run.id, run.jobId, topicId, run.source, run.scheduledAt, run.status);
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
      claimed.push({
        job: toJob(row),
        run: insertRun(row.id, row.topic_id, "manual", row.requested_at),
      });
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
      const run = insertRun(job.id, job.topicId, "schedule", job.nextRunAt);
      const nextRunAt = computeNextCronRun(job.schedule, now, job.timezone).toISOString();
      db.query("UPDATE negotium_cron_jobs SET next_run_at = ? WHERE id = ?").run(nextRunAt, job.id);
      claimed.push({ job: { ...job, nextRunAt }, run });
    }
  })();
  return claimed;
}

export function markCronRunStarted(runId: string, queryId: string, now = new Date()): void {
  ensureCronSchema();
  db.query(
    `UPDATE negotium_cron_runs
     SET status = 'running', query_id = ?, started_at = COALESCE(started_at, ?)
     WHERE id = ?`,
  ).run(queryId, now.toISOString(), runId);
}

export function finishCronRun(
  runId: string,
  result: {
    status: Exclude<CronRunStatus, "pending" | "running">;
    outputPreview?: string;
    error?: string;
    exitCode?: number;
  },
  now = new Date(),
): number | null {
  ensureCronSchema();
  const row = db
    .query(
      `SELECT r.started_at, r.status, COALESCE(r.topic_id, j.topic_id) AS topic_id
       FROM negotium_cron_runs r
       JOIN negotium_cron_jobs j ON j.id = r.job_id
       WHERE r.id = ?`,
    )
    .get(runId) as
    | { started_at: string | null; status: CronRunStatus; topic_id: string }
    | undefined;
  if (!row || (row.status !== "pending" && row.status !== "running")) return null;
  const durationMs = row?.started_at
    ? Math.max(0, now.getTime() - Date.parse(row.started_at))
    : null;
  let successfulRunsSinceRotation: number | null = null;
  db.transaction(() => {
    const exitCode =
      result.exitCode ??
      ({ succeeded: 0, skipped: 0, failed: 1, aborted: 130, interrupted: 137 } as const)[
        result.status
      ];
    const updated = db
      .query(
        `UPDATE negotium_cron_runs
       SET status = ?, finished_at = ?, duration_ms = ?, output_preview = ?, error = ?, exit_code = ?
       WHERE id = ? AND status IN ('pending','running')`,
      )
      .run(
        result.status,
        now.toISOString(),
        durationMs,
        result.outputPreview?.slice(0, 500) ?? null,
        result.error ?? null,
        exitCode,
        runId,
      );
    if (Number(updated.changes) > 0 && result.status === "succeeded") {
      successfulRunsSinceRotation = incrementCronTopicSuccess(row.topic_id, now);
    }
  })();
  return successfulRunsSinceRotation;
}

export function listCronRuns(jobId: string, limit = 20): CronRunRecord[] {
  ensureCronSchema();
  return (
    db
      .query("SELECT * FROM negotium_cron_runs WHERE job_id = ? ORDER BY scheduled_at DESC LIMIT ?")
      .all(jobId, limit) as RunRow[]
  ).map(toRun);
}

export function getLastCronRun(jobId: string): CronRunRecord | null {
  return listCronRuns(jobId, 1)[0] ?? null;
}

export function countCronRuns(jobId: string): number {
  ensureCronSchema();
  const row = db
    .query("SELECT COUNT(*) AS count FROM negotium_cron_runs WHERE job_id = ?")
    .get(jobId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function recoverPendingCronRuns(
  limit = 100,
): Array<{ job: CronJobRecord; run: CronRunRecord }> {
  ensureCronSchema();
  const rows = db
    .query(
      `SELECT r.id AS run_id, r.job_id AS run_job_id, r.source AS run_source,
              r.scheduled_at AS run_scheduled_at, r.started_at AS run_started_at,
              r.finished_at AS run_finished_at, r.status AS run_status,
              r.query_id AS run_query_id, r.duration_ms AS run_duration_ms,
              r.output_preview AS run_output_preview, r.error AS run_error,
              r.exit_code AS run_exit_code,
              r.topic_id AS run_topic_id,
              j.*
       FROM negotium_cron_runs r
       JOIN negotium_cron_jobs j ON j.id = r.job_id
       WHERE r.status = 'pending'
       ORDER BY r.scheduled_at
       LIMIT ?`,
    )
    .all(limit) as Array<
    JobRow & {
      run_id: string;
      run_job_id: string;
      run_source: "schedule" | "manual";
      run_scheduled_at: string;
      run_started_at: string | null;
      run_finished_at: string | null;
      run_status: CronRunStatus;
      run_query_id: string | null;
      run_duration_ms: number | null;
      run_output_preview: string | null;
      run_error: string | null;
      run_exit_code: number | null;
      run_topic_id: string | null;
    }
  >;
  return rows.map((row) => ({
    job: toJob(row),
    run: toRun({
      id: row.run_id,
      job_id: row.run_job_id,
      source: row.run_source,
      scheduled_at: row.run_scheduled_at,
      started_at: row.run_started_at,
      finished_at: row.run_finished_at,
      status: row.run_status,
      query_id: row.run_query_id,
      duration_ms: row.run_duration_ms,
      output_preview: row.run_output_preview,
      error: row.run_error,
      exit_code: row.run_exit_code,
      topic_id: row.run_topic_id,
    }),
  }));
}

export function finalizeOrphanedCronRuns(now = new Date()): number {
  ensureCronSchema();
  const result = db
    .query(
      `UPDATE negotium_cron_runs
       SET status = 'interrupted', finished_at = ?, exit_code = 137,
           error = 'node restarted after dispatch; final outcome is unknown'
       WHERE status = 'running'`,
    )
    .run(now.toISOString());
  return Number(result.changes);
}
