import { randomUUID } from "node:crypto";
import { db } from "#storage/forum-db";
import { TURN_LEASE_STALE_MS } from "#storage/runtime-leases";
import { getRuntimeTopicEpoch, TOPIC_MAINTENANCE_STALE_MS } from "#storage/runtime-topic-state";
import type { AgentKind, EffortLevel, PeerRuntimeBridgeContext } from "#types";

const REQUEST_CLAIM_STALE_MS = TURN_LEASE_STALE_MS;

/** Serializable execution details that must survive a cross-process handoff. */
export interface RuntimeUserTurnExecution {
  runtimeEpoch?: number;
  sourceRequestId?: string;
  agentOverride?: AgentKind;
  modelOverride?: string;
  effortOverride?: EffortLevel;
  sessionId?: string | null;
  sessionIdSpecified?: boolean;
  sessionScope?: "topic" | "isolated";
  cwd?: string;
  sessionName?: string;
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
  visualTools?: boolean;
  fileDeliveryTools?: boolean;
  bridgeSessionFromHistory?: boolean;
  peerBridge?: PeerRuntimeBridgeContext;
  from?: string;
}

export interface RuntimeUserTurnRequest {
  requestId: string;
  topicId: string;
  userId: string;
  prompt: string;
  attachments?: string[];
  allowAutoContinue: boolean;
  execution?: RuntimeUserTurnExecution;
  topicEpoch: number;
  createdAt: number;
  status: "pending" | "running";
  claimedBy?: string;
  claimedAt?: number;
  runningQueryId?: string;
}

interface RuntimeUserTurnRequestRow {
  request_id: string;
  topic_id: string;
  user_id: string;
  prompt: string;
  attachments_json: string | null;
  allow_auto_continue: number;
  execution_json: string | null;
  topic_epoch: number | bigint;
  created_at: number | bigint;
  status: string;
  claimed_by: string | null;
  claimed_at: number | bigint | null;
  running_query_id: string | null;
}

function createRuntimeUserTurnRequestsTable(): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_user_turn_requests (
    request_id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    attachments_json TEXT,
    allow_auto_continue INTEGER NOT NULL DEFAULT 1 CHECK (allow_auto_continue IN (0, 1)),
    execution_json TEXT,
    topic_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running')),
    claimed_by TEXT,
    claimed_at INTEGER,
    running_query_id TEXT
  )
`);
}

createRuntimeUserTurnRequestsTable();

const legacyTopicPrimaryKey = db
  .query<{ name: string; pk: number }, []>("PRAGMA table_info(runtime_user_turn_requests)")
  .all()
  .some((column) => column.name === "topic_id" && column.pk === 1);
if (legacyTopicPrimaryKey) {
  db.transaction(() => {
    db.exec("ALTER TABLE runtime_user_turn_requests RENAME TO runtime_user_turn_requests_legacy");
    createRuntimeUserTurnRequestsTable();
    db.exec(`
      INSERT INTO runtime_user_turn_requests (
        request_id, topic_id, user_id, prompt, attachments_json,
        allow_auto_continue, execution_json, topic_epoch, created_at,
        status, claimed_by, claimed_at, running_query_id
      )
      SELECT request_id, topic_id, user_id, prompt, attachments_json,
        allow_auto_continue, execution_json, topic_epoch, created_at,
        status, claimed_by, claimed_at, running_query_id
      FROM runtime_user_turn_requests_legacy
    `);
    db.exec("DROP TABLE runtime_user_turn_requests_legacy");
  })();
}
try {
  db.exec("ALTER TABLE runtime_user_turn_requests ADD COLUMN execution_json TEXT");
} catch {
  // Existing standalone database already has the additive handoff column.
}
try {
  db.exec(
    "ALTER TABLE runtime_user_turn_requests ADD COLUMN topic_epoch INTEGER NOT NULL DEFAULT 0",
  );
} catch {
  // Existing standalone database already has the additive epoch column.
}
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_runtime_user_turn_requests_ready ON runtime_user_turn_requests(status, created_at)",
);

function rowToRequest(row: RuntimeUserTurnRequestRow): RuntimeUserTurnRequest {
  let attachments: string[] | undefined;
  if (row.attachments_json) {
    try {
      const parsed = JSON.parse(row.attachments_json) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        attachments = parsed;
      }
    } catch {
      attachments = undefined;
    }
  }
  let execution: RuntimeUserTurnExecution | undefined;
  if (row.execution_json) {
    try {
      const parsed = JSON.parse(row.execution_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        execution = parsed as RuntimeUserTurnExecution;
      }
    } catch {
      execution = undefined;
    }
  }
  return {
    requestId: row.request_id,
    topicId: row.topic_id,
    userId: row.user_id,
    prompt: row.prompt,
    attachments,
    allowAutoContinue: row.allow_auto_continue !== 0,
    execution,
    topicEpoch: Number(row.topic_epoch),
    createdAt: Number(row.created_at),
    status: row.status === "running" ? "running" : "pending",
    claimedBy: row.claimed_by ?? undefined,
    claimedAt: row.claimed_at === null ? undefined : Number(row.claimed_at),
    runningQueryId: row.running_query_id ?? undefined,
  };
}

export function enqueueRuntimeUserTurnRequest(input: {
  topicId: string;
  userId: string;
  prompt: string;
  attachments?: string[];
  allowAutoContinue: boolean;
  requestId?: string;
  execution?: RuntimeUserTurnExecution;
  topicEpoch?: number;
  /** Existing channel behavior supersedes queued work; gateways opt into FIFO. */
  supersedeExisting?: boolean;
}): string {
  const requestId = input.requestId ?? randomUUID();
  const now = Date.now();
  const topicEpoch = input.topicEpoch ?? getRuntimeTopicEpoch(input.topicId);
  db.transaction(() => {
    if (input.supersedeExisting !== false) {
      db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ?").run(input.topicId);
    }
    db.query(
      `INSERT INTO runtime_user_turn_requests
       (request_id, topic_id, user_id, prompt, attachments_json,
        allow_auto_continue, execution_json, topic_epoch, created_at,
        status, claimed_by, claimed_at, running_query_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)
     ON CONFLICT(request_id) DO NOTHING`,
    ).run(
      requestId,
      input.topicId,
      input.userId,
      input.prompt,
      input.attachments?.length ? JSON.stringify(input.attachments) : null,
      input.allowAutoContinue ? 1 : 0,
      input.execution ? JSON.stringify(input.execution) : null,
      topicEpoch,
      now,
    );
  })();
  return requestId;
}

export function claimNextRuntimeUserTurnRequest(
  ownerId: string,
  now = Date.now(),
): RuntimeUserTurnRequest | null {
  return db
    .transaction(() => {
      const row = db
        .query<RuntimeUserTurnRequestRow, [number, number, number, number, number]>(
          `SELECT r.*
         FROM runtime_user_turn_requests r
         LEFT JOIN runtime_turn_leases l ON l.topic_id = r.topic_id
         LEFT JOIN runtime_topic_state s ON s.topic_id = r.topic_id
         WHERE (l.topic_id IS NULL OR l.heartbeat_at < ?)
           AND (s.topic_id IS NULL OR s.maintenance = 0 OR s.heartbeat_at < ?)
           AND r.topic_epoch = COALESCE(s.epoch, 0)
           AND NOT EXISTS (
             SELECT 1
             FROM runtime_user_turn_requests active
             WHERE active.topic_id = r.topic_id
               AND active.request_id <> r.request_id
               AND active.claimed_at IS NOT NULL
               AND active.claimed_at >= ?
           )
           AND (
             (r.status = 'pending' AND (r.claimed_at IS NULL OR r.claimed_at < ?))
             OR (r.status = 'running' AND (r.claimed_at IS NULL OR r.claimed_at < ?))
           )
         ORDER BY r.created_at ASC, r.rowid ASC
         LIMIT 1`,
        )
        .get(
          now - TURN_LEASE_STALE_MS,
          now - TOPIC_MAINTENANCE_STALE_MS,
          now - REQUEST_CLAIM_STALE_MS,
          now - REQUEST_CLAIM_STALE_MS,
          now - REQUEST_CLAIM_STALE_MS,
        );
      if (!row) return null;
      const updated = db
        .query(
          `UPDATE runtime_user_turn_requests
         SET claimed_by = ?, claimed_at = ?
         WHERE request_id = ? AND topic_id = ?
           AND (
             (status = 'pending' AND (claimed_at IS NULL OR claimed_at < ?))
             OR (status = 'running' AND (claimed_at IS NULL OR claimed_at < ?))
           )`,
        )
        .run(
          ownerId,
          now,
          row.request_id,
          row.topic_id,
          now - REQUEST_CLAIM_STALE_MS,
          now - REQUEST_CLAIM_STALE_MS,
        );
      if (Number(updated.changes ?? 0) === 0) return null;
      return rowToRequest({ ...row, claimed_by: ownerId, claimed_at: now });
    })
    .immediate();
}

export function markRuntimeUserTurnRunning(
  topicId: string,
  requestId: string,
  ownerId: string,
  queryId: string,
): boolean {
  const result = db
    .query(
      `UPDATE runtime_user_turn_requests
       SET status = 'running', running_query_id = ?, claimed_at = ?
       WHERE topic_id = ? AND request_id = ? AND claimed_by = ?`,
    )
    .run(queryId, Date.now(), topicId, requestId, ownerId);
  return Number(result.changes ?? 0) > 0;
}

export function releaseRuntimeUserTurnClaim(
  topicId: string,
  requestId: string,
  ownerId: string,
): boolean {
  const result = db
    .query(
      `UPDATE runtime_user_turn_requests
       SET status = 'pending', claimed_by = NULL, claimed_at = NULL, running_query_id = NULL
       WHERE topic_id = ? AND request_id = ? AND claimed_by = ?`,
    )
    .run(topicId, requestId, ownerId);
  return Number(result.changes ?? 0) > 0;
}

export function completeRuntimeUserTurnRequest(topicId: string, requestId: string): boolean {
  const result = db
    .query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ? AND request_id = ?")
    .run(topicId, requestId);
  return Number(result.changes ?? 0) > 0;
}

/** Cancel work captured before a reset/delete epoch began. */
export function cancelRuntimeUserTurnRequestsBeforeEpoch(topicId: string, epoch: number): string[] {
  const rows = db
    .query<{ request_id: string }, [string, number]>(
      "SELECT request_id FROM runtime_user_turn_requests WHERE topic_id = ? AND topic_epoch < ?",
    )
    .all(topicId, epoch);
  db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ? AND topic_epoch < ?").run(
    topicId,
    epoch,
  );
  return rows.map((row) => row.request_id);
}

export function cancelRuntimeUserTurnRequests(topicId: string): string[] {
  const rows = db
    .query<{ request_id: string }, [string]>(
      "SELECT request_id FROM runtime_user_turn_requests WHERE topic_id = ?",
    )
    .all(topicId);
  db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ?").run(topicId);
  return rows.map((row) => row.request_id);
}

export function getRuntimeUserTurnRequest(topicId: string): RuntimeUserTurnRequest | null {
  const row = db
    .query<RuntimeUserTurnRequestRow, [string]>(
      "SELECT * FROM runtime_user_turn_requests WHERE topic_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(topicId);
  return row ? rowToRequest(row) : null;
}
