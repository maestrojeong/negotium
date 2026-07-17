import { errMsg } from "#platform/error";
import { logger } from "#platform/logger";
import { db } from "#storage/forum-db";
import { closeStorageDatabase, registerStorageSchemaInitializer } from "#storage/storage-host";
import { type AgentKind, isAgentKind } from "#types";

export { db };

export interface ForumTopicInfo {
  messageThreadId: number;
  sessionId: string;
  createdAt: string;
  name: string;
  description?: string;
  forkOrigin?: string;
  agent: AgentKind;
}

export interface UserForumConfig {
  communicateThreadId?: number;
  dmSessionId?: string;
  topics: { [topicName: string]: ForumTopicInfo };
}

export type TopicRow = {
  user_id: string;
  name: string;
  message_thread_id: number;
  session_id: string | null;
  created_at: string;
  description: string | null;
  fork_origin: string | null;
  agent: string | null;
};

export type UserRow = {
  id: string;
  dm_session_id: string | null;
  communicate_thread_id: number | null;
};

function initializeForumSchema(): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    dm_session_id TEXT,
    communicate_thread_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS topics (
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    message_thread_id INTEGER NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL,
    description TEXT,
    fork_origin TEXT,
    agent TEXT NOT NULL DEFAULT 'claude',
    mcp_enabled TEXT,
    mcp_extra TEXT,
    last_shown_model TEXT,
    last_shown_effort TEXT,
    last_shown_agent TEXT,
    PRIMARY KEY (user_id, name),
    UNIQUE (user_id, message_thread_id)
  );

  CREATE INDEX IF NOT EXISTS idx_topics_lookup ON topics(user_id, message_thread_id);
`);

  function tryMigrate(sql: string, expectedMsg?: string): void {
    try {
      db.exec(sql);
    } catch (e) {
      if (expectedMsg && errMsg(e).includes(expectedMsg)) return;
      logger.error({ err: e, sql }, "DB migration failed");
      throw e;
    }
  }

  type SqlValue = string | number | bigint | boolean | null | Uint8Array;

  function sqlValue(value: unknown): SqlValue {
    if (value === undefined || value === null) return null;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (value instanceof Uint8Array) return value;
    return String(value);
  }

  function columnExists(table: string, column: string): boolean {
    return db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
  }

  function tableSql(table: string): string | null {
    return (
      db
        .query<{ sql: string }, string>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table)?.sql ?? null
    );
  }

  function dropColumnIfExists(table: string, column: string): void {
    if (columnExists(table, column)) {
      tryMigrate(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }

  function topicTableNeedsRebuild(): boolean {
    const sql = tableSql("topics");
    if (!sql) return false;
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(topics)").all();
    const names = new Set(cols.map((c) => c.name));
    return (
      names.has("forum_group_id") ||
      names.has("system_prompt_extra") ||
      names.has("model") ||
      names.has("effort") ||
      names.has("model_pinned") ||
      names.has("effort_pinned") ||
      names.has("memory_files") ||
      names.has("memory_summary") ||
      names.has("privacy_mode") ||
      names.has("advisor_enabled") ||
      names.has("agent_settings") ||
      !/PRIMARY KEY \(\s*user_id\s*,\s*name\s*\)/i.test(sql)
    );
  }

  function normalizeStoredAgent(value: unknown): AgentKind {
    if (isAgentKind(value)) return value;
    if (value === "hermes" || value === "alpha") return "maestro";
    return "claude";
  }

  function rebuildTopicsTableIfNeeded(): void {
    if (!topicTableNeedsRebuild()) return;

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(topics)").all();
    const has = new Set(cols.map((c) => c.name));
    const pick = (row: Record<string, unknown>, column: string, fallback: unknown = null) =>
      has.has(column) ? (row[column] ?? fallback) : fallback;
    const descriptionFor = (row: Record<string, unknown>) =>
      pick(row, "description", pick(row, "system_prompt_extra", null));

    const rows = db
      .query<Record<string, unknown>, []>("SELECT rowid AS __rowid, * FROM topics")
      .all()
      .sort((a, b) => {
        const aCreated = String(pick(a, "created_at", ""));
        const bCreated = String(pick(b, "created_at", ""));
        const byDate = bCreated.localeCompare(aCreated);
        if (byDate !== 0) return byDate;
        return Number(b.__rowid ?? 0) - Number(a.__rowid ?? 0);
      });

    const previousForeignKeys = db
      .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
      .get()?.foreign_keys;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec("DROP TABLE IF EXISTS topics_new");
        db.exec(`
        CREATE TABLE topics_new (
          user_id TEXT NOT NULL REFERENCES users(id),
          name TEXT NOT NULL,
          message_thread_id INTEGER NOT NULL,
          session_id TEXT,
          created_at TEXT NOT NULL,
          description TEXT,
          fork_origin TEXT,
          agent TEXT NOT NULL DEFAULT 'claude',
          mcp_enabled TEXT,
          mcp_extra TEXT,
          last_shown_model TEXT,
          last_shown_effort TEXT,
          last_shown_agent TEXT,
          PRIMARY KEY (user_id, name),
          UNIQUE (user_id, message_thread_id)
        )
      `);

        const insert = db.query(`
        INSERT OR IGNORE INTO topics_new
          (user_id, name, message_thread_id, session_id, created_at, description,
           fork_origin, agent, mcp_enabled, mcp_extra, last_shown_model,
           last_shown_effort, last_shown_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
        let inserted = 0;
        const fallbackCreatedAt = new Date().toISOString();
        for (const row of rows) {
          const result = insert.run(
            String(pick(row, "user_id", "")),
            String(pick(row, "name", "")),
            Number(pick(row, "message_thread_id", 0)),
            sqlValue(pick(row, "session_id", null)),
            String(pick(row, "created_at", fallbackCreatedAt)),
            sqlValue(descriptionFor(row)),
            sqlValue(pick(row, "fork_origin", null)),
            normalizeStoredAgent(pick(row, "agent", "claude")),
            sqlValue(pick(row, "mcp_enabled", null)),
            sqlValue(pick(row, "mcp_extra", null)),
            sqlValue(pick(row, "last_shown_model", null)),
            sqlValue(pick(row, "last_shown_effort", null)),
            sqlValue(pick(row, "last_shown_agent", null)),
          );
          if (Number(result.changes ?? 0) > 0) inserted += 1;
        }

        db.exec("DROP TABLE topics");
        db.exec("ALTER TABLE topics_new RENAME TO topics");
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_topics_lookup ON topics(user_id, message_thread_id)",
        );
        logger.info(
          { migrated: inserted, skippedConflicts: rows.length - inserted },
          "topics schema migrated to current user-scoped schema",
        );
      })();
    } finally {
      db.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
    }
  }

  rebuildTopicsTableIfNeeded();

  tryMigrate("ALTER TABLE topics ADD COLUMN fork_origin TEXT", "duplicate column");
  tryMigrate(
    "ALTER TABLE topics ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'",
    "duplicate column",
  );
  tryMigrate("ALTER TABLE topics ADD COLUMN mcp_enabled TEXT", "duplicate column");
  tryMigrate("ALTER TABLE topics ADD COLUMN mcp_extra TEXT", "duplicate column");
  tryMigrate("ALTER TABLE topics ADD COLUMN last_shown_model TEXT", "duplicate column");
  tryMigrate("ALTER TABLE topics ADD COLUMN last_shown_effort TEXT", "duplicate column");
  tryMigrate("ALTER TABLE topics ADD COLUMN last_shown_agent TEXT", "duplicate column");

  for (const column of ["privacy_mode", "advisor_enabled", "agent_settings"]) {
    dropColumnIfExists("topics", column);
  }
  dropColumnIfExists("users", "manager_session_id");

  tryMigrate("DROP INDEX idx_topics_lookup", "no such index");
  tryMigrate("CREATE INDEX IF NOT EXISTS idx_topics_lookup ON topics(user_id, message_thread_id)");

  function assertColumn(table: string, column: string): void {
    if (!columnExists(table, column)) {
      throw new Error(`Schema migration failed: ${table}.${column} is missing`);
    }
  }

  for (const column of ["id", "dm_session_id", "communicate_thread_id"]) {
    assertColumn("users", column);
  }
  for (const column of [
    "user_id",
    "name",
    "message_thread_id",
    "session_id",
    "created_at",
    "description",
    "fork_origin",
    "agent",
    "mcp_enabled",
    "mcp_extra",
    "last_shown_model",
    "last_shown_effort",
    "last_shown_agent",
  ]) {
    assertColumn("topics", column);
  }
}

registerStorageSchemaInitializer(initializeForumSchema, 10);

export function rowToTopic(row: TopicRow): ForumTopicInfo {
  if (!isAgentKind(row.agent)) throw new Error(`Invalid agent in DB: ${row.agent}`);
  const agent: AgentKind = row.agent;
  return {
    messageThreadId: row.message_thread_id,
    sessionId: row.session_id ?? "",
    createdAt: row.created_at,
    name: row.name,
    agent,
    ...(row.description && { description: row.description }),
    ...(row.fork_origin && { forkOrigin: row.fork_origin }),
  };
}

export function flushSessionCache() {
  closeStorageDatabase();
}

export { logger };
