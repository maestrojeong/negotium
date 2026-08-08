/**
 * Adapter-owned durable peer state — the negotium equivalent of otium's
 * `peer_inbox_requests` and remote-ask tables, kept in negotium's shared SQLite
 * (one machine = one runtime process = one WAL database). Table names are
 * prefixed so the adapter never collides with core schema.
 *
 * Invariant these tables carry: at-least-once inbound requests, exactly-once
 * delivery — a requestId claim must survive worker restarts.
 *
 * The placed-turn tables (`otium_peer_sessions`, `otium_peer_turn_requests`,
 * `otium_peer_terminal_outbox`) are gone with the placement receiver, as
 * `otium_shared_topic_state`, `otium_shared_message_outbox` and
 * `otium_peer_lifecycle` went with the earlier message-copying path (D-1).
 * Nothing recreates them, and nothing drops them either: an existing database
 * keeps the unused tables so a downgrade cannot lose rows.
 */

import { createHash } from "node:crypto";
import { db } from "@negotium/core";

db.exec(`
  CREATE TABLE IF NOT EXISTS otium_peer_inbox_requests (
    from_cell_id  TEXT NOT NULL,
    request_id    TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('tell', 'ask')),
    topic_id      TEXT NOT NULL,
    payload_hash  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (from_cell_id, request_id, kind)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS otium_remote_asks (
    request_id       TEXT PRIMARY KEY,
    expected_cell_id TEXT NOT NULL,
    user_id          TEXT NOT NULL,
    caller_topic_id  TEXT NOT NULL,
    from_key         TEXT NOT NULL,
    to_key           TEXT NOT NULL,
    source_query_id  TEXT,
    created_at       INTEGER NOT NULL
  )
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_otium_remote_asks_created
  ON otium_remote_asks(created_at)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS otium_peer_reply_outbox (
    node_cell_id TEXT NOT NULL,
    request_id   TEXT NOT NULL,
    node_name    TEXT NOT NULL,
    topic_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    source_title TEXT NOT NULL,
    reply_text   TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('reply', 'error')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (node_cell_id, request_id)
  )
`);

export interface PeerTopicCleanupResult {
  inboxRequests: number;
  remoteAsks: number;
}

/**
 * Remove adapter-owned state whose local topic was hard-deleted.
 *
 * Only cross-node session state is left to reconcile: an inbound tell/ask
 * requestId claim scoped to that topic, and any outbound remote ask whose caller
 * room was that topic. Both would otherwise outlive the room they belong to —
 * the remote ask permanently, since nothing else ever revisits its row.
 */
export function cleanupPeerStateForLocalTopic(localTopicId: string): PeerTopicCleanupResult {
  return db.transaction(() => {
    const inboxRequests = db.run("DELETE FROM otium_peer_inbox_requests WHERE topic_id = ?", [
      localTopicId,
    ]).changes;
    const remoteAsks = db.run("DELETE FROM otium_remote_asks WHERE caller_topic_id = ?", [
      localTopicId,
    ]).changes;
    return { inboxRequests, remoteAsks };
  })();
}

// ── peer inbox requests: durable idempotent claim for inbound tell/ask ──

export type PeerInboxKind = "tell" | "ask";

export type PeerInboxClaimOutcome = "claimed" | "replay" | "conflict";

export function peerInboxPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Claim an inbound tell/ask by (fromCellId, requestId, kind). Replays of the
 * exact payload ack idempotently; the same requestId with a different payload
 * is a conflict (409 upstream).
 */
export function claimPeerInboxRequest(args: {
  fromCellId: string;
  requestId: string;
  kind: PeerInboxKind;
  topicId: string;
  payloadHash: string;
}): { outcome: PeerInboxClaimOutcome } {
  const inserted = db.run(
    `INSERT OR IGNORE INTO otium_peer_inbox_requests
       (from_cell_id, request_id, kind, topic_id, payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      args.fromCellId,
      args.requestId,
      args.kind,
      args.topicId,
      args.payloadHash,
      new Date().toISOString(),
    ],
  );
  if (inserted.changes === 1) return { outcome: "claimed" };
  const existing = db
    .query<{ payload_hash: string }, [string, string, string]>(
      "SELECT payload_hash FROM otium_peer_inbox_requests WHERE from_cell_id = ? AND request_id = ? AND kind = ?",
    )
    .get(args.fromCellId, args.requestId, args.kind);
  if (!existing) return { outcome: "conflict" };
  return { outcome: existing.payload_hash === args.payloadHash ? "replay" : "conflict" };
}

/** Undo a claim whose side effect (inbox append) failed, so the sender's
 *  retry can re-claim instead of being swallowed as a replay. */
export function releasePeerInboxRequest(
  fromCellId: string,
  requestId: string,
  kind: PeerInboxKind,
): void {
  db.run(
    "DELETE FROM otium_peer_inbox_requests WHERE from_cell_id = ? AND request_id = ? AND kind = ?",
    [fromCellId, requestId, kind],
  );
}

// ── outbound remote asks: durable reply routing across worker restarts ──

export interface RemoteAskRow {
  request_id: string;
  expected_cell_id: string;
  user_id: string;
  caller_topic_id: string;
  from_key: string;
  to_key: string;
  source_query_id: string | null;
  created_at: number;
}

export function createRemoteAsk(args: {
  requestId: string;
  expectedCellId: string;
  userId: string;
  callerTopicId: string;
  from: string;
  to: string;
  sourceQueryId?: string;
  createdAt?: number;
}): boolean {
  const result = db.run(
    `INSERT OR IGNORE INTO otium_remote_asks
       (request_id, expected_cell_id, user_id, caller_topic_id, from_key, to_key,
        source_query_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.requestId,
      args.expectedCellId,
      args.userId,
      args.callerTopicId,
      args.from,
      args.to,
      args.sourceQueryId ?? null,
      args.createdAt ?? Date.now(),
    ],
  );
  return result.changes === 1;
}

export function getRemoteAsk(requestId: string): RemoteAskRow | null {
  return (
    db
      .query<RemoteAskRow, [string]>("SELECT * FROM otium_remote_asks WHERE request_id = ?")
      .get(requestId) ?? null
  );
}

export function deleteRemoteAsk(requestId: string): boolean {
  return db.run("DELETE FROM otium_remote_asks WHERE request_id = ?", [requestId]).changes === 1;
}

export function pruneRemoteAsks(olderThan: number): number {
  return db.run("DELETE FROM otium_remote_asks WHERE created_at < ?", [olderThan]).changes;
}

// ── outbound peer replies: durable until the source node acknowledges ──

export interface PeerReplyOutboxRow {
  node_cell_id: string;
  request_id: string;
  node_name: string;
  topic_id: string;
  user_id: string;
  source_title: string;
  reply_text: string;
  kind: "reply" | "error";
  created_at: number;
  updated_at: number;
}

export function upsertPeerReplyOutbox(args: {
  nodeCellId: string;
  requestId: string;
  nodeName: string;
  topicId: string;
  userId: string;
  sourceTitle: string;
  replyText: string;
  kind: "reply" | "error";
}): void {
  const now = Date.now();
  db.run(
    `INSERT INTO otium_peer_reply_outbox
       (node_cell_id, request_id, node_name, topic_id, user_id, source_title,
        reply_text, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(node_cell_id, request_id) DO UPDATE SET
       node_name = excluded.node_name,
       topic_id = excluded.topic_id,
       user_id = excluded.user_id,
       source_title = excluded.source_title,
       reply_text = excluded.reply_text,
       kind = excluded.kind,
       updated_at = excluded.updated_at`,
    [
      args.nodeCellId,
      args.requestId,
      args.nodeName,
      args.topicId,
      args.userId,
      args.sourceTitle,
      args.replyText,
      args.kind,
      now,
      now,
    ],
  );
}

export function listPeerReplyOutbox(limit = 100): PeerReplyOutboxRow[] {
  return db
    .query<PeerReplyOutboxRow, [number]>(
      "SELECT * FROM otium_peer_reply_outbox ORDER BY created_at LIMIT ?",
    )
    .all(limit);
}

export function deletePeerReplyOutbox(nodeCellId: string, requestId: string): boolean {
  return (
    db.run("DELETE FROM otium_peer_reply_outbox WHERE node_cell_id = ? AND request_id = ?", [
      nodeCellId,
      requestId,
    ]).changes === 1
  );
}
