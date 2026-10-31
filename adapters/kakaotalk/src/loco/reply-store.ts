/**
 * Pending LOCO reply targets, keyed by topic — the LOCO-transport sibling of
 * ../callback-store.ts.
 *
 * Open Builder gives a one-shot `callbackUrl`; LOCO has no such concept
 * (the daemon process holds a persistent session and `send(chatId, text)`
 * works anytime), so the only thing this needs to hand off across the
 * webhook-handler-process / `send_kakaotalk`-subprocess boundary is the
 * `chatId` to reply into. No expiry is needed for correctness (LOCO can
 * reply whenever), but one is still applied — a stale target from a much
 * earlier trigger answering a much later, unrelated turn would be a real
 * bug, not a feature.
 *
 * "Most recent wins" + "consumed once" mirrors callback-store.ts's contract
 * so send_kakaotalk's behavior (success/failure shape, "once per trigger")
 * is identical regardless of which transport the inbound message arrived
 * on.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "@negotium/core";

export interface PendingLocoReplyTarget {
  requestId: string;
  topicId: string;
  chatId: number;
  /** Epoch ms; rows past this are treated as expired and skipped. */
  expiresAt: number;
}

export interface LocoReplyStore {
  put(entry: PendingLocoReplyTarget): void;
  /** Most recent non-expired, non-consumed reply target for a topic, if any. */
  takeLatest(topicId: string): PendingLocoReplyTarget | null;
  close(): void;
}

export function openLocoReplyStore(dbPath?: string): LocoReplyStore {
  const file = dbPath ?? join(DATA_DIR, "adapter-kakaotalk-loco-replies.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_loco_replies (
      request_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending_loco_replies_topic
      ON pending_loco_replies(topic_id, expires_at);
  `);

  return {
    put(entry) {
      db.query(
        `INSERT OR REPLACE INTO pending_loco_replies (request_id, topic_id, chat_id, expires_at, consumed)
         VALUES (?, ?, ?, ?, 0)`,
      ).run(entry.requestId, entry.topicId, entry.chatId, entry.expiresAt);
    },
    takeLatest(topicId) {
      const now = Date.now();
      const row = db
        .query(
          `SELECT request_id, chat_id, expires_at FROM pending_loco_replies
           WHERE topic_id = ? AND consumed = 0 AND expires_at > ?
           ORDER BY expires_at DESC LIMIT 1`,
        )
        .get(topicId, now) as
        | { request_id: string; chat_id: number; expires_at: number }
        | undefined;
      if (!row) return null;
      db.query("UPDATE pending_loco_replies SET consumed = 1 WHERE request_id = ?").run(
        row.request_id,
      );
      return {
        requestId: row.request_id,
        topicId,
        chatId: row.chat_id,
        expiresAt: row.expires_at,
      };
    },
    close() {
      db.close();
    },
  };
}
