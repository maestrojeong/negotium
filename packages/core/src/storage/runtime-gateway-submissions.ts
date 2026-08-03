import { db } from "#storage/forum-db";

export interface RuntimeGatewaySubmission {
  clientMessageId: string;
  requestId: string;
  topicId: string;
  messageId: string;
  userId: string;
  createdAt: string;
  ackCursor: number;
  messageCursor: number;
  /** Hash of every ingress field that can change canonical or execution semantics. */
  payloadHash?: string;
}

interface RuntimeGatewaySubmissionRow {
  client_message_id: string;
  request_id: string;
  topic_id: string;
  message_id: string;
  user_id: string;
  created_at: string;
  ack_cursor: number | bigint;
  message_cursor: number | bigint;
  payload_hash: string | null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_gateway_submissions (
    client_message_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    topic_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ack_cursor INTEGER NOT NULL DEFAULT 0,
    message_cursor INTEGER NOT NULL DEFAULT 0,
    payload_hash TEXT
  )
`);
try {
  db.exec(
    "ALTER TABLE runtime_gateway_submissions ADD COLUMN ack_cursor INTEGER NOT NULL DEFAULT 0",
  );
} catch {}
try {
  db.exec("ALTER TABLE runtime_gateway_submissions ADD COLUMN payload_hash TEXT");
} catch {}
try {
  db.exec(
    "ALTER TABLE runtime_gateway_submissions ADD COLUMN message_cursor INTEGER NOT NULL DEFAULT 0",
  );
} catch {}
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_runtime_gateway_submissions_topic ON runtime_gateway_submissions(topic_id)",
);

function rowToSubmission(row: RuntimeGatewaySubmissionRow): RuntimeGatewaySubmission {
  return {
    clientMessageId: row.client_message_id,
    requestId: row.request_id,
    topicId: row.topic_id,
    messageId: row.message_id,
    userId: row.user_id,
    createdAt: row.created_at,
    ackCursor: Number(row.ack_cursor),
    messageCursor: Number(row.message_cursor),
    payloadHash: row.payload_hash ?? undefined,
  };
}

export function findRuntimeGatewaySubmission(
  clientMessageId: string,
  requestId: string,
): RuntimeGatewaySubmission | null {
  const row = db
    .query<RuntimeGatewaySubmissionRow, [string, string]>(
      `SELECT * FROM runtime_gateway_submissions
       WHERE client_message_id = ? OR request_id = ?
       ORDER BY CASE WHEN client_message_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(clientMessageId, requestId, clientMessageId);
  return row ? rowToSubmission(row) : null;
}

/**
 * Attach a payload hash to a submission recorded before the `payload_hash`
 * column existed (or before it was populated for that row). Called the first
 * time a legacy row is confirmed to match a duplicate request on every field
 * we *can* verify, so every subsequent replay under the same key is checked
 * against the full semantic payload instead of the narrower legacy field set.
 * A no-op once the row already has a hash, so it never overwrites a value
 * `submitRuntimeGatewayTurn` already trusts.
 */
export function backfillRuntimeGatewaySubmissionPayloadHash(
  clientMessageId: string,
  payloadHash: string,
): void {
  db.query(
    `UPDATE runtime_gateway_submissions
       SET payload_hash = ?
       WHERE client_message_id = ? AND payload_hash IS NULL`,
  ).run(payloadHash, clientMessageId);
}

export function recordRuntimeGatewaySubmission(submission: RuntimeGatewaySubmission): void {
  db.query(
    `INSERT INTO runtime_gateway_submissions
       (client_message_id, request_id, topic_id, message_id, user_id, created_at,
        ack_cursor, message_cursor, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    submission.clientMessageId,
    submission.requestId,
    submission.topicId,
    submission.messageId,
    submission.userId,
    submission.createdAt,
    submission.ackCursor,
    submission.messageCursor,
    submission.payloadHash ?? null,
  );
}
