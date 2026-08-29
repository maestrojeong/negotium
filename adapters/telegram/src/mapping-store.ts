/**
 * Persistent (chatId, threadId) ↔ negotium-topic mapping.
 *
 * Forum mode materializes runtime topics as real Telegram forum threads; the
 * thread id Telegram assigns exists nowhere else, so the binding must survive
 * restarts or every subagent room would grow a duplicate thread on reboot.
 * One SQLite file (default `${DATA_DIR}/adapter-telegram.db`) holds all
 * mappings.
 *
 * Schema semantics:
 *   - a chat/thread routes to exactly one topic (UNIQUE (chat_id, thread_id);
 *     re-binding replaces that one row),
 *   - a topic MAY be bound by several chats/threads (fan-out) — there is
 *     deliberately no UNIQUE on topic_id, so binding a topic somewhere new
 *     never steals it from an existing chat.
 *   - `tombstones` records topics whose forum-thread creation failed, so a
 *     restart keeps delivering them into the general chat (with a `[title]`
 *     prefix) instead of re-attempting creation or dropping messages.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, type RuntimeBusEvent } from "@negotium/core";

export interface PersistedMapping {
  chatId: number;
  /** Absent = the whole chat (DM / supergroup general), not a forum thread. */
  threadId?: number;
  topicId: string;
}

export interface PersistedTombstone {
  topicId: string;
  title: string;
}

export interface PersistedTelegramGroup {
  chatId: number;
  title?: string;
  ownerTelegramUserId?: number;
}

export interface PersistedRuntimeEvent {
  seq: number;
  event: RuntimeBusEvent;
}

/** One durable outbound-retry entry (clawgram's telegram-outbox pattern,
 *  simplified to a SQLite table in the adapter's own db). */
export interface OutboxEntry {
  id: number;
  chatId: number;
  threadId?: number;
  /** Runtime source message, used to cancel superseded retries. */
  runtimeMessageId?: string;
  /** Footer already embedded in this chunk, if any. */
  footer?: string;
  html: string;
  plain: string;
  attempts: number;
  /** Epoch ms before which the flusher must not retry. */
  nextTryAt: number;
  /** 1 = permanently failed (kept for operator visibility, never retried). */
  dead: boolean;
  lastError?: string;
}

export interface TelegramMappingStore {
  load(): PersistedMapping[];
  /** Upsert by (chatId, threadId). Never touches other rows of the same topic. */
  save(mapping: PersistedMapping): void;
  deleteByChat(chatId: number, threadId?: number): void;
  deleteByTopic(topicId: string): void;
  loadTombstones(): PersistedTombstone[];
  saveTombstone(topicId: string, title: string): void;
  deleteTombstone(topicId: string): void;
  clearTombstones(): void;
  /** Forum supergroup selected by auto-connect. A configured environment
   *  value may overwrite it, but normal restarts recover it from here. */
  loadForumChatId(): number | undefined;
  saveForumChatId(chatId: number): void;
  clearForumChatId(): void;
  loadGroups(): PersistedTelegramGroup[];
  saveGroup(group: PersistedTelegramGroup): void;
  deleteGroup(chatId: number): void;
  /** One-shot migration flags (e.g. the surface backfill). */
  isFlagSet(key: string): boolean;
  setFlag(key: string): void;
  runtimeEventCursor(): number | undefined;
  captureRuntimeEvent(event: RuntimeBusEvent & { seq: number }): void;
  advanceRuntimeEventCursor(seq: number): void;
  pendingRuntimeEvents(): PersistedRuntimeEvent[];
  acknowledgeRuntimeEvent(seq: number): void;
  // ── outbound retry queue ──────────────────────────────────────────
  outboxEnqueue(entry: {
    chatId: number;
    threadId?: number;
    runtimeMessageId?: string;
    footer?: string;
    html: string;
    plain: string;
    nextTryAt: number;
    lastError?: string;
  }): void;
  /** Live (non-dead) entries due at `now`, oldest first. */
  outboxDue(now: number): OutboxEntry[];
  /** Write back a transient failure: bump attempts, reschedule. */
  outboxReschedule(id: number, attempts: number, nextTryAt: number, lastError: string): void;
  outboxMarkDead(id: number, attempts: number, lastError: string): void;
  outboxDelete(id: number): void;
  outboxDeleteByChat(chatId: number): void;
  outboxDeleteByRuntimeMessageId(runtimeMessageId: string): void;
  /** All entries (tests/operator inspection). */
  outboxAll(): OutboxEntry[];
  close(): void;
}

/** Telegram thread ids start at 1, so 0 safely encodes "no thread" — needed
 *  because SQLite UNIQUE treats NULLs as distinct and would allow duplicate
 *  (chat_id, NULL) rows. */
const NO_THREAD = 0;

interface MappingRow {
  chat_id: number;
  thread_id: number;
  topic_id: string;
}

interface TombstoneRow {
  topic_id: string;
  title: string;
}

interface OutboxRow {
  id: number;
  chat_id: number;
  thread_id: number;
  runtime_message_id: string | null;
  footer: string | null;
  html: string;
  plain: string;
  attempts: number;
  next_try_at: number;
  dead: number;
  last_error: string | null;
}

interface RuntimeInboxRow {
  seq: number;
  event_json: string;
}

function outboxRowToEntry(row: OutboxRow): OutboxEntry {
  return {
    id: row.id,
    chatId: row.chat_id,
    ...(row.thread_id !== NO_THREAD ? { threadId: row.thread_id } : {}),
    ...(row.runtime_message_id !== null ? { runtimeMessageId: row.runtime_message_id } : {}),
    ...(row.footer !== null ? { footer: row.footer } : {}),
    html: row.html,
    plain: row.plain,
    attempts: row.attempts,
    nextTryAt: row.next_try_at,
    dead: row.dead === 1,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  };
}

/** v1 schema had `UNIQUE (topic_id)`, which let INSERT OR REPLACE silently
 *  delete another chat's binding of the same topic. SQLite can't drop a
 *  constraint in place, so rebuild the young table without it. */
function migrateLegacySchema(db: Database): void {
  const existing = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mappings'")
    .get() as { sql?: string } | null;
  if (!existing?.sql?.includes("UNIQUE (topic_id)")) return;
  db.run("DROP TABLE IF EXISTS mappings_legacy");
  db.run("ALTER TABLE mappings RENAME TO mappings_legacy");
  createTables(db);
  db.run(
    `INSERT OR IGNORE INTO mappings (chat_id, thread_id, topic_id)
     SELECT chat_id, thread_id, topic_id FROM mappings_legacy`,
  );
  db.run("DROP TABLE mappings_legacy");
}

function createTables(db: Database): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS mappings (
      chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL DEFAULT ${NO_THREAD},
      topic_id TEXT NOT NULL,
      UNIQUE (chat_id, thread_id)
    )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS tombstones (
      topic_id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL DEFAULT ${NO_THREAD},
      runtime_message_id TEXT,
      footer TEXT,
      html TEXT NOT NULL,
      plain TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_try_at INTEGER NOT NULL,
      dead INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS telegram_groups (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      owner_telegram_user_id INTEGER,
      created_at TEXT NOT NULL
    )`,
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS runtime_inbox (
      seq INTEGER PRIMARY KEY,
      runtime_message_id TEXT,
      event_json TEXT NOT NULL
    )`,
  );
}

function migrateOutboxSchema(db: Database): void {
  try {
    db.run("ALTER TABLE outbox ADD COLUMN runtime_message_id TEXT");
  } catch {
    // Column already exists.
  }
  try {
    db.run("ALTER TABLE outbox ADD COLUMN footer TEXT");
  } catch {
    // Column already exists.
  }
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_telegram_outbox_runtime_message ON outbox(runtime_message_id)",
  );
}

function migrateRuntimeInboxSchema(db: Database): void {
  try {
    db.run("ALTER TABLE runtime_inbox ADD COLUMN runtime_message_id TEXT");
  } catch {
    // Column already exists.
  }
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_runtime_inbox_message
     ON runtime_inbox(runtime_message_id) WHERE runtime_message_id IS NOT NULL`,
  );
}

/** Open (creating if needed) the mapping database. `path` is injectable for
 *  tests; production uses the node's data dir. */
export function openMappingStore(path?: string): TelegramMappingStore {
  const dbPath = path ?? join(DATA_DIR, "adapter-telegram.db");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  migrateLegacySchema(db);
  createTables(db);
  const legacyForum = db.query("SELECT value FROM settings WHERE key = 'forum_chat_id'").get() as {
    value: string;
  } | null;
  if (legacyForum) {
    const chatId = Number.parseInt(legacyForum.value, 10);
    if (Number.isSafeInteger(chatId)) {
      db.run(
        `INSERT OR IGNORE INTO telegram_groups (chat_id, created_at)
         VALUES (?, ?)`,
        [chatId, new Date().toISOString()],
      );
    }
  }
  migrateOutboxSchema(db);
  migrateRuntimeInboxSchema(db);
  return {
    load(): PersistedMapping[] {
      const rows = db
        .query("SELECT chat_id, thread_id, topic_id FROM mappings")
        .all() as MappingRow[];
      return rows.map((row) => ({
        chatId: row.chat_id,
        topicId: row.topic_id,
        ...(row.thread_id !== NO_THREAD ? { threadId: row.thread_id } : {}),
      }));
    },
    save(mapping: PersistedMapping): void {
      // OR REPLACE only collides on (chat_id, thread_id) — re-binding a
      // chat/thread replaces its own row and leaves the topic's other
      // bindings intact.
      db.run(
        `INSERT OR REPLACE INTO mappings (chat_id, thread_id, topic_id)
         VALUES (?, ?, ?)`,
        [mapping.chatId, mapping.threadId ?? NO_THREAD, mapping.topicId],
      );
    },
    deleteByChat(chatId: number, threadId?: number): void {
      db.run("DELETE FROM mappings WHERE chat_id = ? AND thread_id = ?", [
        chatId,
        threadId ?? NO_THREAD,
      ]);
    },
    deleteByTopic(topicId: string): void {
      db.run("DELETE FROM mappings WHERE topic_id = ?", [topicId]);
    },
    loadTombstones(): PersistedTombstone[] {
      const rows = db.query("SELECT topic_id, title FROM tombstones").all() as TombstoneRow[];
      return rows.map((row) => ({ topicId: row.topic_id, title: row.title }));
    },
    saveTombstone(topicId: string, title: string): void {
      db.run("INSERT OR REPLACE INTO tombstones (topic_id, title) VALUES (?, ?)", [topicId, title]);
    },
    deleteTombstone(topicId: string): void {
      db.run("DELETE FROM tombstones WHERE topic_id = ?", [topicId]);
    },
    clearTombstones(): void {
      db.run("DELETE FROM tombstones");
    },
    loadForumChatId(): number | undefined {
      const row = db.query("SELECT value FROM settings WHERE key = 'forum_chat_id'").get() as {
        value: string;
      } | null;
      if (!row) return undefined;
      const value = Number.parseInt(row.value, 10);
      return Number.isSafeInteger(value) ? value : undefined;
    },
    saveForumChatId(chatId: number): void {
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('forum_chat_id', ?)", [
        String(chatId),
      ]);
    },
    clearForumChatId(): void {
      db.run("DELETE FROM settings WHERE key = 'forum_chat_id'");
    },
    loadGroups(): PersistedTelegramGroup[] {
      const rows = db
        .query(
          "SELECT chat_id, title, owner_telegram_user_id FROM telegram_groups ORDER BY created_at",
        )
        .all() as Array<{
        chat_id: number;
        title: string | null;
        owner_telegram_user_id: number | null;
      }>;
      return rows.map((row) => ({
        chatId: row.chat_id,
        ...(row.title ? { title: row.title } : {}),
        ...(row.owner_telegram_user_id !== null
          ? { ownerTelegramUserId: row.owner_telegram_user_id }
          : {}),
      }));
    },
    saveGroup(group: PersistedTelegramGroup): void {
      db.run(
        `INSERT INTO telegram_groups (chat_id, title, owner_telegram_user_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           title = COALESCE(excluded.title, telegram_groups.title),
           owner_telegram_user_id = COALESCE(
             excluded.owner_telegram_user_id,
             telegram_groups.owner_telegram_user_id
           )`,
        [
          group.chatId,
          group.title ?? null,
          group.ownerTelegramUserId ?? null,
          new Date().toISOString(),
        ],
      );
    },
    deleteGroup(chatId: number): void {
      db.run("DELETE FROM telegram_groups WHERE chat_id = ?", [chatId]);
    },
    isFlagSet(key: string): boolean {
      return db.query("SELECT 1 FROM settings WHERE key = ?").get(key) !== null;
    },
    setFlag(key: string): void {
      db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
        key,
        new Date().toISOString(),
      ]);
    },
    outboxEnqueue(entry): void {
      db.run(
        `INSERT INTO outbox
           (chat_id, thread_id, runtime_message_id, footer, html, plain, attempts, next_try_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          entry.chatId,
          entry.threadId ?? NO_THREAD,
          entry.runtimeMessageId ?? null,
          entry.footer ?? null,
          entry.html,
          entry.plain,
          entry.nextTryAt,
          entry.lastError ?? null,
        ],
      );
    },
    runtimeEventCursor(): number | undefined {
      const row = db
        .query("SELECT value FROM settings WHERE key = 'runtime_event_cursor'")
        .get() as {
        value: string;
      } | null;
      if (!row) return undefined;
      const value = Number.parseInt(row.value, 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    },
    captureRuntimeEvent(event): void {
      const messageId =
        event.payload &&
        typeof event.payload === "object" &&
        "id" in event.payload &&
        typeof event.payload.id === "string"
          ? event.payload.id
          : null;
      db.transaction(() => {
        db.run(
          `INSERT OR IGNORE INTO runtime_inbox (seq, runtime_message_id, event_json)
           VALUES (?, ?, ?)`,
          [event.seq, messageId, JSON.stringify(event)],
        );
        db.run(
          `INSERT INTO settings (key, value) VALUES ('runtime_event_cursor', ?)
           ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`,
          [String(event.seq)],
        );
      })();
    },
    advanceRuntimeEventCursor(seq): void {
      db.run(
        `INSERT INTO settings (key, value) VALUES ('runtime_event_cursor', ?)
         ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`,
        [String(seq)],
      );
    },
    pendingRuntimeEvents(): PersistedRuntimeEvent[] {
      const rows = db
        .query("SELECT seq, event_json FROM runtime_inbox ORDER BY seq ASC")
        .all() as RuntimeInboxRow[];
      return rows.flatMap((row) => {
        try {
          return [{ seq: row.seq, event: JSON.parse(row.event_json) as RuntimeBusEvent }];
        } catch {
          db.run("DELETE FROM runtime_inbox WHERE seq = ?", [row.seq]);
          return [];
        }
      });
    },
    acknowledgeRuntimeEvent(seq): void {
      db.run("DELETE FROM runtime_inbox WHERE seq = ?", [seq]);
    },
    outboxDue(now: number): OutboxEntry[] {
      const rows = db
        .query("SELECT * FROM outbox WHERE dead = 0 AND next_try_at <= ? ORDER BY id ASC")
        .all(now) as OutboxRow[];
      return rows.map(outboxRowToEntry);
    },
    outboxReschedule(id: number, attempts: number, nextTryAt: number, lastError: string): void {
      db.run("UPDATE outbox SET attempts = ?, next_try_at = ?, last_error = ? WHERE id = ?", [
        attempts,
        nextTryAt,
        lastError,
        id,
      ]);
    },
    outboxMarkDead(id: number, attempts: number, lastError: string): void {
      db.run("UPDATE outbox SET dead = 1, attempts = ?, last_error = ? WHERE id = ?", [
        attempts,
        lastError,
        id,
      ]);
    },
    outboxDelete(id: number): void {
      db.run("DELETE FROM outbox WHERE id = ?", [id]);
    },
    outboxDeleteByChat(chatId: number): void {
      db.run("DELETE FROM outbox WHERE chat_id = ?", [chatId]);
    },
    outboxDeleteByRuntimeMessageId(runtimeMessageId: string): void {
      db.run("DELETE FROM outbox WHERE runtime_message_id = ?", [runtimeMessageId]);
    },
    outboxAll(): OutboxEntry[] {
      const rows = db.query("SELECT * FROM outbox ORDER BY id ASC").all() as OutboxRow[];
      return rows.map(outboxRowToEntry);
    },
    close(): void {
      db.close();
    },
  };
}
