import { randomUUID } from "node:crypto";
import {
  flattenUserTurnAttachments,
  legacyUserTurnEnvelope,
  renderUserTurnBatch,
  type UserTurnEnvelope,
} from "#runtime/user-turn-envelope";
import { db } from "#storage/forum-db";
import { TURN_LEASE_STALE_MS } from "#storage/runtime-leases";
import { getRuntimeTopicEpoch, TOPIC_MAINTENANCE_STALE_MS } from "#storage/runtime-topic-state";
import type { StorageDatabase } from "#storage/storage-contract";
import { registerStorageSchemaInitializer } from "#storage/storage-host";
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
  /** Vault namespace for this turn, independent from the local execution principal. */
  vaultUserId?: string;
  /** Newly accepted user texts not yet recorded in the unified conversation log. */
  conversationPrompts?: string[];
  /** Number of leading userMessages already present in the unified conversation log. */
  loggedUserMessageCount?: number;
  /** Native session whose provider output proves it accepted this request's user turn. */
  providerSessionId?: string;
  /** Request ids whose ordered messages were folded into this replacement. */
  supersededRequestIds?: string[];
}

export interface RuntimeUserTurnRequest {
  requestId: string;
  topicId: string;
  userId: string;
  prompt: string;
  userMessages: UserTurnEnvelope[];
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
  user_messages_json: string | null;
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

function createRuntimeUserTurnRequestsTable(database: StorageDatabase): void {
  database.exec(`
  CREATE TABLE IF NOT EXISTS runtime_user_turn_requests (
    request_id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    user_messages_json TEXT,
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

/** Apply additive upgrades and the legacy topic-primary-key rebuild to one database. */
export function ensureRuntimeUserTurnRequestsSchema(database: StorageDatabase): void {
  createRuntimeUserTurnRequestsTable(database);

  try {
    database.exec("ALTER TABLE runtime_user_turn_requests ADD COLUMN execution_json TEXT");
  } catch {
    // Existing standalone database already has the additive handoff column.
  }
  try {
    database.exec("ALTER TABLE runtime_user_turn_requests ADD COLUMN user_messages_json TEXT");
  } catch {
    // Existing standalone database already has the additive envelope column.
  }
  try {
    database.exec(
      "ALTER TABLE runtime_user_turn_requests ADD COLUMN topic_epoch INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Existing standalone database already has the additive epoch column.
  }

  const legacyTopicPrimaryKey = database
    .query<{ name: string; pk: number }, []>("PRAGMA table_info(runtime_user_turn_requests)")
    .all()
    .some((column) => column.name === "topic_id" && column.pk === 1);
  if (legacyTopicPrimaryKey) {
    database.transaction(() => {
      database.exec(
        "ALTER TABLE runtime_user_turn_requests RENAME TO runtime_user_turn_requests_legacy",
      );
      createRuntimeUserTurnRequestsTable(database);
      database.exec(`
      INSERT INTO runtime_user_turn_requests (
        request_id, topic_id, user_id, prompt, user_messages_json, attachments_json,
        allow_auto_continue, execution_json, topic_epoch, created_at,
        status, claimed_by, claimed_at, running_query_id
      )
      SELECT request_id, topic_id, user_id, prompt, NULL, attachments_json,
        allow_auto_continue, execution_json, topic_epoch, created_at,
        status, claimed_by, claimed_at, running_query_id
      FROM runtime_user_turn_requests_legacy
    `);
      database.exec("DROP TABLE runtime_user_turn_requests_legacy");
    })();
  }
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_runtime_user_turn_requests_ready ON runtime_user_turn_requests(status, created_at)",
  );
}

// Registered rather than run at import time. Calling this with `db` on module
// evaluation resolves the storage connection immediately, which for an
// embedding host happens before `configureStorageHost()` — Negotium then opens
// and caches its own database in the default state directory, and every later
// caller silently keeps using it instead of the host's.
registerStorageSchemaInitializer((database) =>
  ensureRuntimeUserTurnRequestsSchema(database as unknown as StorageDatabase),
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
  let userMessages: UserTurnEnvelope[] | undefined;
  if (row.user_messages_json) {
    try {
      const parsed = JSON.parse(row.user_messages_json) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof (item as UserTurnEnvelope).prompt === "string" &&
            ((item as UserTurnEnvelope).attachments === undefined ||
              (Array.isArray((item as UserTurnEnvelope).attachments) &&
                (item as UserTurnEnvelope).attachments?.every(
                  (attachment) => typeof attachment === "string",
                ))) &&
            ((item as UserTurnEnvelope).actorUserId === undefined ||
              typeof (item as UserTurnEnvelope).actorUserId === "string") &&
            ((item as UserTurnEnvelope).actorLabel === undefined ||
              typeof (item as UserTurnEnvelope).actorLabel === "string"),
        )
      ) {
        userMessages = parsed as UserTurnEnvelope[];
      }
    } catch {
      userMessages = undefined;
    }
  }
  // Pre-envelope rows cannot associate a batched attachment list with individual
  // messages. Preserve their historic provider input as one submission instead.
  userMessages ??= [legacyUserTurnEnvelope(row.prompt, attachments)];
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
    userMessages,
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
  userMessages?: UserTurnEnvelope[];
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
       (request_id, topic_id, user_id, prompt, user_messages_json, attachments_json,
        allow_auto_continue, execution_json, topic_epoch, created_at,
        status, claimed_by, claimed_at, running_query_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)
     ON CONFLICT(request_id) DO NOTHING`,
    ).run(
      requestId,
      input.topicId,
      input.userId,
      input.prompt,
      input.userMessages?.length ? JSON.stringify(input.userMessages) : null,
      input.attachments?.length ? JSON.stringify(input.attachments) : null,
      input.allowAutoContinue ? 1 : 0,
      input.execution ? JSON.stringify(input.execution) : null,
      topicEpoch,
      now,
    );
  })();
  return requestId;
}

function loggedMessageCount(request: RuntimeUserTurnRequest): number {
  const explicit = request.execution?.loggedUserMessageCount;
  if (typeof explicit === "number" && Number.isInteger(explicit)) {
    return Math.min(Math.max(0, explicit), request.userMessages.length);
  }
  const legacyPendingPrompts = request.execution?.conversationPrompts;
  if (legacyPendingPrompts) {
    return Math.max(0, request.userMessages.length - legacyPendingPrompts.length);
  }
  return 0;
}

/**
 * Atomically fold every accepted request for a topic into one replacement.
 * BEGIN IMMEDIATE serializes cross-process readers before they observe and
 * replace the current rows, preventing the classic read/merge/delete race.
 */
export function mergeRuntimeUserTurnRequest(input: {
  topicId: string;
  userId: string;
  userMessages: UserTurnEnvelope[];
  allowAutoContinue: boolean;
  requestId: string;
  execution: RuntimeUserTurnExecution;
  topicEpoch: number;
  alreadyIncludedRequestIds?: string[];
  /** Requests already committed to the provider's native session; keep their lineage, not prompts. */
  omitRequestIds?: string[];
}): { requestId: string; supersededRequestIds: string[] } {
  const now = Date.now();
  return db
    .transaction(() => {
      const rows = db
        .query<RuntimeUserTurnRequestRow, [string]>(
          "SELECT * FROM runtime_user_turn_requests WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .all(input.topicId);
      const previous = rows.map(rowToRequest);
      const omittedRequestIds = new Set([
        ...(input.omitRequestIds ?? []),
        ...previous
          .filter((request) => Boolean(request.execution?.providerSessionId))
          .map((request) => request.requestId),
      ]);
      const carried = previous.filter((request) => !omittedRequestIds.has(request.requestId));
      const alreadyIncludedRequestIds = new Set(input.alreadyIncludedRequestIds ?? []);
      const alreadyIncludedMessages = carried
        .filter((request) => alreadyIncludedRequestIds.has(request.requestId))
        .flatMap((request) => request.userMessages);
      const includedPrefixMatches = alreadyIncludedMessages.every((message, index) => {
        const candidate = input.userMessages[index];
        return (
          candidate?.prompt === message.prompt &&
          candidate.actorUserId === message.actorUserId &&
          candidate.actorLabel === message.actorLabel &&
          JSON.stringify(candidate.attachments ?? []) === JSON.stringify(message.attachments ?? [])
        );
      });
      const alreadyIncludedMessageCount = includedPrefixMatches
        ? alreadyIncludedMessages.length
        : 0;
      const userMessages = [
        ...carried.flatMap((request) => request.userMessages),
        ...input.userMessages.slice(alreadyIncludedMessageCount),
      ];
      const incomingLoggedCount = Math.min(
        Math.max(0, input.execution.loggedUserMessageCount ?? 0),
        input.userMessages.length,
      );
      const loggedUserMessageCount =
        carried.reduce((count, request) => count + loggedMessageCount(request), 0) +
        Math.max(0, incomingLoggedCount - alreadyIncludedMessageCount);
      const execution: RuntimeUserTurnExecution = {
        ...input.execution,
        loggedUserMessageCount,
        supersededRequestIds: [
          ...new Set(
            previous.flatMap((request) => [
              request.requestId,
              ...(request.execution?.supersededRequestIds ?? []),
            ]),
          ),
        ],
        conversationPrompts: userMessages
          .slice(loggedUserMessageCount)
          .map((message) => message.prompt),
      };
      const sessionBase = carried.find(
        (request) => request.execution?.sessionIdSpecified,
      )?.execution;
      if (sessionBase?.sessionIdSpecified) {
        execution.sessionId = sessionBase.sessionId;
        execution.sessionIdSpecified = true;
      }
      const attachments = flattenUserTurnAttachments(userMessages);

      db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ?").run(input.topicId);
      db.query(
        `INSERT INTO runtime_user_turn_requests
         (request_id, topic_id, user_id, prompt, user_messages_json, attachments_json,
          allow_auto_continue, execution_json, topic_epoch, created_at,
          status, claimed_by, claimed_at, running_query_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
      ).run(
        input.requestId,
        input.topicId,
        input.userId,
        renderUserTurnBatch(userMessages),
        JSON.stringify(userMessages),
        attachments?.length ? JSON.stringify(attachments) : null,
        input.allowAutoContinue ? 1 : 0,
        JSON.stringify(execution),
        input.topicEpoch,
        now,
      );
      return {
        requestId: input.requestId,
        supersededRequestIds: previous.map((request) => request.requestId),
      };
    })
    .immediate();
}

/**
 * Record that provider output proves the native session contains this durable
 * turn. A session-id event alone is insufficient: some providers publish it
 * before appending the user prompt. This marker lets a different runtime
 * process omit only a demonstrably committed prompt when it merges a steering
 * message after preemption.
 *
 * Match only the exact request id. A late session event from a superseded turn
 * must not mark its replacement (whose prompts have not reached the provider).
 */
export function markRuntimeUserTurnProviderSessionObserved(
  topicId: string,
  requestId: string,
  sessionId: string,
): boolean {
  return db
    .transaction(() => {
      const row = db
        .query<RuntimeUserTurnRequestRow, [string, string]>(
          "SELECT * FROM runtime_user_turn_requests WHERE topic_id = ? AND request_id = ?",
        )
        .get(topicId, requestId);
      if (!row) return false;
      const request = rowToRequest(row);
      const execution: RuntimeUserTurnExecution = {
        ...request.execution,
        providerSessionId: sessionId,
      };
      const result = db
        .query(
          `UPDATE runtime_user_turn_requests
           SET execution_json = ?
           WHERE topic_id = ? AND request_id = ?`,
        )
        .run(JSON.stringify(execution), topicId, requestId);
      return result.changes === 1;
    })
    .immediate();
}

export function markRuntimeUserTurnMessagesLogged(
  topicId: string,
  requestId: string,
  ownerId: string,
  loggedUserMessages: readonly UserTurnEnvelope[],
): boolean {
  if (loggedUserMessages.length === 0) return false;
  return db
    .transaction(() => {
      const requests = db
        .query<RuntimeUserTurnRequestRow, [string]>(
          "SELECT * FROM runtime_user_turn_requests WHERE topic_id = ? ORDER BY created_at ASC, rowid ASC",
        )
        .all(topicId)
        .map(rowToRequest);
      const hasLoggedPrefix = (request: RuntimeUserTurnRequest): boolean =>
        loggedUserMessages.length <= request.userMessages.length &&
        loggedUserMessages.every((message, index) => {
          const candidate = request.userMessages[index];
          return (
            candidate?.prompt === message.prompt &&
            candidate.actorUserId === message.actorUserId &&
            candidate.actorLabel === message.actorLabel &&
            JSON.stringify(candidate.attachments ?? []) ===
              JSON.stringify(message.attachments ?? [])
          );
        });
      const request =
        requests.find(
          (candidate) =>
            candidate.requestId === requestId &&
            candidate.claimedBy === ownerId &&
            hasLoggedPrefix(candidate),
        ) ??
        requests.find(
          (candidate) =>
            candidate.execution?.supersededRequestIds?.includes(requestId) &&
            hasLoggedPrefix(candidate),
        );
      if (!request) return false;
      const count = Math.max(loggedMessageCount(request), loggedUserMessages.length);
      const execution: RuntimeUserTurnExecution = {
        ...request.execution,
        loggedUserMessageCount: count,
        conversationPrompts: request.userMessages.slice(count).map((message) => message.prompt),
      };
      const result = db
        .query(
          `UPDATE runtime_user_turn_requests
           SET execution_json = ?
           WHERE topic_id = ? AND request_id = ?`,
        )
        .run(JSON.stringify(execution), topicId, request.requestId);
      return result.changes === 1;
    })
    .immediate();
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

export function completeRuntimeUserTurnRequest(
  topicId: string,
  requestId: string,
  ownerId: string,
): boolean {
  const result = db
    .query(
      `DELETE FROM runtime_user_turn_requests
       WHERE topic_id = ? AND request_id = ? AND claimed_by = ?`,
    )
    .run(topicId, requestId, ownerId);
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
