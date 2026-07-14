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
  inboxRequests: number;
}

/**
 * Remove adapter-owned state whose local execution topic was hard-deleted.
 * Turn rows are linked indirectly through the host room binding, so they must
 * be removed before the session rows that provide that relationship.
 */
export function cleanupPeerStateForLocalTopic(localTopicId: string): PeerTopicCleanupResult {
  return db.transaction(() => {
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
    const sessions = db.run("DELETE FROM otium_peer_sessions WHERE local_topic_id = ?", [
      localTopicId,
    ]).changes;
    return { sessions, turns, inboxRequests };
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
     WHERE status IN ('claimed', 'running')`,
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
