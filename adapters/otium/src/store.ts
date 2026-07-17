/**
 * Adapter-owned durable peer state —
 * equivalents of otium's `peer_sessions`, `peer_turn_requests` and
 * `peer_inbox_requests` tables, kept in negotium's shared SQLite (one machine
 * = one runtime process = one WAL database). Table names are prefixed so the
 * adapter never collides with core schema.
 *
 * Invariant these tables carry: at-least-once inbound requests, exactly-once
 * execution. requestId claims must survive worker restarts; interrupted
 * claimed/running turns are failed wholesale on startup.
 */

import { createHash } from "node:crypto";
import { db } from "@negotium/core";

db.exec(`
  CREATE TABLE IF NOT EXISTS otium_peer_sessions (
    host_node_id    TEXT NOT NULL,
    host_topic_id   TEXT NOT NULL,
    local_topic_id  TEXT NOT NULL,
    binding_mode    TEXT NOT NULL DEFAULT 'mirror',
    created_at      TEXT NOT NULL,
    PRIMARY KEY (host_node_id, host_topic_id)
  )
`);

const peerSessionColumns = new Set(
  db
    .query<{ name: string }, []>("PRAGMA table_info(otium_peer_sessions)")
    .all()
    .map((row) => row.name),
);
if (!peerSessionColumns.has("binding_mode")) {
  db.exec("ALTER TABLE otium_peer_sessions ADD COLUMN binding_mode TEXT NOT NULL DEFAULT 'mirror'");
}

// Migrate mirrors created before core had an explicit visibility boundary.
// `isSubagent` remains execution metadata; it is no longer used as a picker
// hiding convention.
db.run(
  `UPDATE api_topics
   SET visibility = 'hidden', access_mode = 'shared'
   WHERE id IN (
     SELECT local_topic_id FROM otium_peer_sessions WHERE binding_mode = 'mirror'
   )`,
);
db.run(
  `UPDATE api_topics
   SET access_mode = 'shared'
   WHERE id IN (SELECT local_topic_id FROM otium_peer_sessions)`,
);

db.exec(`
  CREATE TABLE IF NOT EXISTS otium_peer_turn_requests (
    host_node_id   TEXT NOT NULL,
    request_id     TEXT NOT NULL,
    host_topic_id  TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN
                   ('claimed', 'running', 'finished', 'failed')),
    error          TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (host_node_id, request_id)
  )
`);

// A terminal is not completion until the canonical hub acknowledges it. Keep
// the exact envelope so a worker restart can replay it; the hub's event
// journal makes that replay idempotent when the original ACK was lost.
db.exec(`
  CREATE TABLE IF NOT EXISTS otium_peer_terminal_outbox (
    host_node_id  TEXT NOT NULL,
    request_id    TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    event_json    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (host_node_id, request_id)
  )
`);

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

// ── peer sessions: Otium room → hidden mirror OR user-selected shared topic ──

export type PeerTopicBindingMode = "mirror" | "shared";

export interface PeerSessionRow {
  host_node_id: string;
  host_topic_id: string;
  local_topic_id: string;
  binding_mode: PeerTopicBindingMode;
  created_at: string;
}

export function getPeerSession(hostNodeId: string, hostTopicId: string): PeerSessionRow | null {
  return (
    db
      .query<PeerSessionRow, [string, string]>(
        "SELECT * FROM otium_peer_sessions WHERE host_node_id = ? AND host_topic_id = ?",
      )
      .get(hostNodeId, hostTopicId) ?? null
  );
}

export function createPeerSession(
  hostNodeId: string,
  hostTopicId: string,
  localTopicId: string,
): PeerSessionRow {
  const row: PeerSessionRow = {
    host_node_id: hostNodeId,
    host_topic_id: hostTopicId,
    local_topic_id: localTopicId,
    binding_mode: "mirror",
    created_at: new Date().toISOString(),
  };
  db.run(
    "INSERT INTO otium_peer_sessions (host_node_id, host_topic_id, local_topic_id, binding_mode, created_at) VALUES (?, ?, ?, ?, ?)",
    [row.host_node_id, row.host_topic_id, row.local_topic_id, row.binding_mode, row.created_at],
  );
  return row;
}

export function bindPeerSession(
  hostNodeId: string,
  hostTopicId: string,
  localTopicId: string,
  mode: PeerTopicBindingMode = "shared",
): PeerSessionRow {
  const row: PeerSessionRow = {
    host_node_id: hostNodeId,
    host_topic_id: hostTopicId,
    local_topic_id: localTopicId,
    binding_mode: mode,
    created_at: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO otium_peer_sessions
       (host_node_id, host_topic_id, local_topic_id, binding_mode, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host_node_id, host_topic_id) DO UPDATE SET
       local_topic_id = excluded.local_topic_id,
       binding_mode = excluded.binding_mode,
       created_at = excluded.created_at`,
    [hostNodeId, hostTopicId, localTopicId, mode, row.created_at],
  );
  return row;
}

export function unbindPeerSession(hostNodeId: string, hostTopicId: string): boolean {
  return (
    db.run("DELETE FROM otium_peer_sessions WHERE host_node_id = ? AND host_topic_id = ?", [
      hostNodeId,
      hostTopicId,
    ]).changes === 1
  );
}

/** Remove every Otium room binding for a topic being made private. */
export function unbindSharedPeerSessionsForLocalTopic(localTopicId: string): number {
  return db.run(
    "DELETE FROM otium_peer_sessions WHERE local_topic_id = ? AND binding_mode = 'shared'",
    [localTopicId],
  ).changes;
}

export function listPeerSessions(): PeerSessionRow[] {
  return db.query<PeerSessionRow, []>("SELECT * FROM otium_peer_sessions").all();
}

export interface PeerTopicCleanupResult {
  sessions: number;
  turns: number;
  terminalOutbox: number;
  inboxRequests: number;
  remoteAsks: number;
}

/**
 * Remove adapter-owned state whose local execution topic was hard-deleted.
 * Turn rows are linked indirectly through the host room binding, so they must
 * be removed before the session rows that provide that relationship.
 */
export function cleanupPeerStateForLocalTopic(localTopicId: string): PeerTopicCleanupResult {
  return db.transaction(() => {
    const terminalOutbox = db.run(
      `DELETE FROM otium_peer_terminal_outbox
       WHERE EXISTS (
         SELECT 1 FROM otium_peer_turn_requests turn_request
         JOIN otium_peer_sessions session
           ON session.host_node_id = turn_request.host_node_id
          AND session.host_topic_id = turn_request.host_topic_id
         WHERE session.local_topic_id = ?
           AND turn_request.host_node_id = otium_peer_terminal_outbox.host_node_id
           AND turn_request.request_id = otium_peer_terminal_outbox.request_id
       )`,
      [localTopicId],
    ).changes;
    const turns = db.run(
      `DELETE FROM otium_peer_turn_requests
       WHERE EXISTS (
         SELECT 1 FROM otium_peer_sessions session
         WHERE session.local_topic_id = ?
           AND session.host_node_id = otium_peer_turn_requests.host_node_id
           AND session.host_topic_id = otium_peer_turn_requests.host_topic_id
       )`,
      [localTopicId],
    ).changes;
    const inboxRequests = db.run("DELETE FROM otium_peer_inbox_requests WHERE topic_id = ?", [
      localTopicId,
    ]).changes;
    const remoteAsks = db.run("DELETE FROM otium_remote_asks WHERE caller_topic_id = ?", [
      localTopicId,
    ]).changes;
    const sessions = db.run("DELETE FROM otium_peer_sessions WHERE local_topic_id = ?", [
      localTopicId,
    ]).changes;
    return { sessions, turns, terminalOutbox, inboxRequests, remoteAsks };
  })();
}

// ── peer turn requests: durable exactly-once claim per (hostCellId, requestId) ──

type PeerTurnRequestStatus = "claimed" | "running" | "finished" | "failed";

export interface PeerTurnRequestRow {
  host_node_id: string;
  request_id: string;
  host_topic_id: string;
  status: PeerTurnRequestStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Recover requests whose in-memory forwarder disappeared with the process. */
export function failInterruptedPeerTurnRequestsOnStartup(): number {
  return db.run(
    `UPDATE otium_peer_turn_requests
     SET status = 'failed', error = 'worker restarted during turn', updated_at = ?
     WHERE status IN ('claimed', 'running')
       AND NOT EXISTS (
         SELECT 1 FROM otium_peer_terminal_outbox terminal
         WHERE terminal.host_node_id = otium_peer_turn_requests.host_node_id
           AND terminal.request_id = otium_peer_turn_requests.request_id
       )`,
    [new Date().toISOString()],
  ).changes;
}

export type ClaimPeerTurnRequestResult =
  | { claimed: true; row: PeerTurnRequestRow }
  | { claimed: false; row: PeerTurnRequestRow };

export function claimPeerTurnRequest(
  hostNodeId: string,
  requestId: string,
  hostTopicId: string,
): ClaimPeerTurnRequestResult {
  const now = new Date().toISOString();
  const inserted = db.run(
    `INSERT OR IGNORE INTO otium_peer_turn_requests
       (host_node_id, request_id, host_topic_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'claimed', ?, ?)`,
    [hostNodeId, requestId, hostTopicId, now, now],
  );
  const row = getPeerTurnRequest(hostNodeId, requestId);
  if (!row) throw new Error("otium peer turn request claim disappeared");
  return { claimed: inserted.changes === 1, row };
}

export function getPeerTurnRequest(
  hostNodeId: string,
  requestId: string,
): PeerTurnRequestRow | null {
  return (
    db
      .query<PeerTurnRequestRow, [string, string]>(
        "SELECT * FROM otium_peer_turn_requests WHERE host_node_id = ? AND request_id = ?",
      )
      .get(hostNodeId, requestId) ?? null
  );
}

function setPeerTurnRequestStatus(
  hostNodeId: string,
  requestId: string,
  status: PeerTurnRequestStatus,
  error: string | null = null,
): void {
  db.run(
    `UPDATE otium_peer_turn_requests
     SET status = ?, error = ?, updated_at = ?
     WHERE host_node_id = ? AND request_id = ?`,
    [status, error, new Date().toISOString(), hostNodeId, requestId],
  );
}

export function markPeerTurnRequestRunning(hostNodeId: string, requestId: string): void {
  setPeerTurnRequestStatus(hostNodeId, requestId, "running");
}

export function markPeerTurnRequestFinished(hostNodeId: string, requestId: string): void {
  setPeerTurnRequestStatus(hostNodeId, requestId, "finished");
}

export function markPeerTurnRequestFailed(
  hostNodeId: string,
  requestId: string,
  error: string,
): void {
  setPeerTurnRequestStatus(hostNodeId, requestId, "failed", error);
}

export interface PeerTerminalOutboxRow {
  host_node_id: string;
  request_id: string;
  seq: number;
  event_json: string;
  created_at: number;
  updated_at: number;
}

export function upsertPeerTerminalOutbox(args: {
  hostNodeId: string;
  requestId: string;
  seq: number;
  event: Record<string, unknown>;
}): void {
  const now = Date.now();
  db.run(
    `INSERT INTO otium_peer_terminal_outbox
       (host_node_id, request_id, seq, event_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(host_node_id, request_id) DO UPDATE SET
       seq = excluded.seq, event_json = excluded.event_json, updated_at = excluded.updated_at`,
    [args.hostNodeId, args.requestId, args.seq, JSON.stringify(args.event), now, now],
  );
}

export function listPeerTerminalOutbox(limit = 100): PeerTerminalOutboxRow[] {
  return db
    .query<PeerTerminalOutboxRow, [number]>(
      "SELECT * FROM otium_peer_terminal_outbox ORDER BY created_at LIMIT ?",
    )
    .all(limit);
}

/** Atomically acknowledge the terminal locally only after the hub ACK. */
export function acknowledgePeerTerminal(hostNodeId: string, requestId: string): boolean {
  return db.transaction(() => {
    const removed = db.run(
      "DELETE FROM otium_peer_terminal_outbox WHERE host_node_id = ? AND request_id = ?",
      [hostNodeId, requestId],
    ).changes;
    if (removed !== 1) return false;
    markPeerTurnRequestFinished(hostNodeId, requestId);
    return true;
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
