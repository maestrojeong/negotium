/**
 * Pending Open Builder callback windows, keyed by topic.
 *
 * Decision #3's constraint in concrete form: Open Builder only lets a skill
 * server answer within the window of ONE specific inbound request (the
 * `callbackUrl` it supplied), and that window is short (operator-configured
 * in Open Builder, default well under a minute). `send_kakaotalk` runs in a
 * separate subprocess from the webhook handler (standard MCP stdio-server
 * pattern — see packages/module-cron/src/mcp-server.ts), so the two cannot
 * share in-memory state; this is the SQLite handoff between them.
 *
 * Only one row is "live" at a time in practice (one manager topic, one
 * in-flight trigger), but the table is still keyed by topic + a request id
 * so a slow turn can't accidentally consume a newer trigger's callback.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "@negotium/core";

export interface PendingCallback {
  requestId: string;
  topicId: string;
  callbackUrl: string;
  /** Epoch ms; rows past this are treated as expired and skipped. */
  expiresAt: number;
}

export interface CallbackStore {
  put(entry: PendingCallback): void;
  /** Most recent non-expired, non-consumed callback for a topic, if any. */
  takeLatest(topicId: string): PendingCallback | null;
  close(): void;
}

export function openCallbackStore(dbPath?: string): CallbackStore {
  const file = dbPath ?? join(DATA_DIR, "adapter-kakaotalk-callbacks.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_callbacks (
      request_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending_callbacks_topic
      ON pending_callbacks(topic_id, expires_at);
  `);

  return {
    put(entry) {
      db.query(
        `INSERT OR REPLACE INTO pending_callbacks (request_id, topic_id, callback_url, expires_at, consumed)
         VALUES (?, ?, ?, ?, 0)`,
      ).run(entry.requestId, entry.topicId, entry.callbackUrl, entry.expiresAt);
    },
    takeLatest(topicId) {
      const now = Date.now();
      const row = db
        .query(
          `SELECT request_id, callback_url, expires_at FROM pending_callbacks
           WHERE topic_id = ? AND consumed = 0 AND expires_at > ?
           ORDER BY expires_at DESC LIMIT 1`,
        )
        .get(topicId, now) as
        | { request_id: string; callback_url: string; expires_at: number }
        | undefined;
      if (!row) return null;
      db.query("UPDATE pending_callbacks SET consumed = 1 WHERE request_id = ?").run(
        row.request_id,
      );
      return {
        requestId: row.request_id,
        topicId,
        callbackUrl: row.callback_url,
        expiresAt: row.expires_at,
      };
    },
    close() {
      db.close();
    },
  };
}
