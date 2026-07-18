import { db } from "#storage/forum-db";

export interface RuntimeGatewaySubmission {
  clientMessageId: string;
  requestId: string;
  topicId: string;
  messageId: string;
  userId: string;
  createdAt: string;
}

interface RuntimeGatewaySubmissionRow {
  client_message_id: string;
  request_id: string;
  topic_id: string;
  message_id: string;
  user_id: string;
  created_at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runtime_gateway_submissions (
    client_message_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    topic_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
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

export function recordRuntimeGatewaySubmission(submission: RuntimeGatewaySubmission): void {
  db.query(
    `INSERT INTO runtime_gateway_submissions
       (client_message_id, request_id, topic_id, message_id, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    submission.clientMessageId,
    submission.requestId,
    submission.topicId,
    submission.messageId,
    submission.userId,
    submission.createdAt,
  );
}
