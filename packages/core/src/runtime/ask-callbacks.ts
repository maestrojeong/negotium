/**
 * Ask callback registry (requestId → caller topic + cleanup).
 *
 * ask_session registers a callback here after the target AI turn is
 * dispatched; when the target AI completes, the turn runner resolves it and
 * routes the result back to the caller topic automatically.
 *
 * Ported from the in-memory registry half of otium's `api/routes/sessions.ts`
 * (the ask/tell REST routes stayed in the host).
 */

import { deliverPeerReply, type RemoteReplyRoute } from "#mcp/session-comm/peer-forward";
import { db } from "#storage/forum-db";
import { PENDING_ASK_TTL_MS, type PendingAskUserId } from "#storage/session-asks";

db.exec(`
  CREATE TABLE IF NOT EXISTS remote_ask_callbacks (
    target_query_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    node_cell_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

interface PendingAskIdentity {
  userId: PendingAskUserId;
  from: string;
  to: string;
  requestId?: string;
}

export interface AskPending {
  requestId: string;
  contextId?: string;
  callerTopicId: string;
  callerUserId: string;
  targetQueryId: string;
  createdAt: number;
  timedOut?: boolean; // set when resolved past TTL — caller gets timeout notice
  pendingAsk?: PendingAskIdentity;
  remoteReply?: RemoteReplyRoute;
}

/** Active callbacks stay in memory for the normal completion path. Remote
 *  reply routes are also persisted so a process restart can explicitly fail
 *  the interrupted ask instead of leaving its caller waiting forever. */
const pendingAsks = new Map<string, AskPending>(); // keyed by targetQueryId (the AI turn's queryId)
const MAX_ASK_AGE_MS = PENDING_ASK_TTL_MS;

/** Register an ask callback. Called after the target AI turn is dispatched. */
export function registerAskCallback(entry: AskPending): void {
  pendingAsks.set(entry.targetQueryId, entry);
  if (entry.remoteReply) {
    db.query(
      `INSERT INTO remote_ask_callbacks
       (target_query_id, request_id, node_name, node_cell_id, topic_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_query_id) DO UPDATE SET
         request_id = excluded.request_id,
         node_name = excluded.node_name,
         node_cell_id = excluded.node_cell_id,
         topic_id = excluded.topic_id,
         user_id = excluded.user_id,
         created_at = excluded.created_at`,
    ).run(
      entry.targetQueryId,
      entry.remoteReply.requestId,
      entry.remoteReply.nodeName,
      entry.remoteReply.nodeCellId,
      entry.remoteReply.topicId,
      entry.remoteReply.userId,
      entry.createdAt,
    );
  }
}

/** Resolve an ask callback after the target AI finishes.
 *  Called from the turn runner when the agent stream ends — matches by the AI
 *  turn's queryId. Returns the AskPending or null if not found.
 *  Past TTL: returns entry with timedOut=true (caller gets timeout notice). */
export function resolveAskCallback(queryId: string): AskPending | null {
  const entry = pendingAsks.get(queryId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > MAX_ASK_AGE_MS) {
    entry.timedOut = true;
  }
  pendingAsks.delete(queryId);
  db.query("DELETE FROM remote_ask_callbacks WHERE target_query_id = ?").run(queryId);
  return entry;
}

/** Clean up stale asks that outlived their TTL (periodic, lightweight). */
export function purgeStaleAsks(now: number = Date.now()): void {
  for (const [id, entry] of pendingAsks) {
    if (now - entry.createdAt > MAX_ASK_AGE_MS) pendingAsks.delete(id);
  }
  db.query("DELETE FROM remote_ask_callbacks WHERE created_at < ?").run(now - MAX_ASK_AGE_MS);
}

/** Drop callbacks whose caller topic was hard-deleted. */
export function cancelAskCallbacksForTopic(topicId: string): number {
  let cancelled = 0;
  for (const [queryId, entry] of pendingAsks) {
    if (entry.callerTopicId !== topicId) continue;
    pendingAsks.delete(queryId);
    db.query("DELETE FROM remote_ask_callbacks WHERE target_query_id = ?").run(queryId);
    cancelled++;
  }
  return cancelled;
}

interface DurableRemoteAskCallbackRow {
  target_query_id: string;
  request_id: string;
  node_name: string;
  node_cell_id: string;
  topic_id: string;
  user_id: string;
}

/** Fail remote asks whose target turn was interrupted by the previous process.
 *  Call once during startup after the peer session bridge is registered. */
export async function failInterruptedRemoteAskCallbacks(): Promise<number> {
  const rows = db
    .query(
      `SELECT target_query_id, request_id, node_name, node_cell_id, topic_id, user_id
       FROM remote_ask_callbacks
       ORDER BY created_at ASC`,
    )
    .all() as DurableRemoteAskCallbackRow[];
  let failed = 0;
  for (const row of rows) {
    const delivered = await deliverPeerReply(
      {
        nodeName: row.node_name,
        nodeCellId: row.node_cell_id,
        topicId: row.topic_id,
        userId: row.user_id,
        requestId: row.request_id,
      },
      "peer",
      "The remote worker restarted before this ask completed. Please retry the request.",
      "error",
    );
    if (!delivered) continue;
    db.query("DELETE FROM remote_ask_callbacks WHERE target_query_id = ?").run(row.target_query_id);
    failed++;
  }
  return failed;
}
