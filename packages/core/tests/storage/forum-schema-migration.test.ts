import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("forum schema migration", () => {
  test("rebuilds legacy group-scoped topics into the current user-scoped schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "otium-forum-schema-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "sessions.db");

    const legacy = new Database(dbPath, { create: true });
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        forum_group_id INTEGER NOT NULL DEFAULT 0,
        dm_session_id TEXT,
        communicate_thread_id INTEGER,
        manager_session_id TEXT
      );

      CREATE TABLE topics (
        user_id TEXT NOT NULL REFERENCES users(id),
        forum_group_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        message_thread_id INTEGER NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        system_prompt_extra TEXT,
        model TEXT,
        privacy_mode INTEGER NOT NULL DEFAULT 0,
        advisor_enabled INTEGER NOT NULL DEFAULT 0,
        effort TEXT CHECK (effort IN ('low', 'medium', 'high')),
        model_pinned INTEGER NOT NULL DEFAULT 0,
        effort_pinned INTEGER NOT NULL DEFAULT 0,
        agent TEXT NOT NULL DEFAULT 'hermes',
        mcp_enabled TEXT,
        mcp_extra TEXT,
        last_shown_model TEXT,
        last_shown_effort TEXT,
        last_shown_agent TEXT,
        PRIMARY KEY (forum_group_id, name),
        UNIQUE (forum_group_id, message_thread_id)
      );
      CREATE INDEX idx_topics_lookup ON topics(forum_group_id, message_thread_id);

      INSERT INTO users (id, forum_group_id, manager_session_id) VALUES ('42', 1001, 'mgr');
      INSERT INTO topics
        (user_id, forum_group_id, name, message_thread_id, session_id, created_at,
         system_prompt_extra, model, privacy_mode, advisor_enabled, effort,
         model_pinned, effort_pinned, agent, mcp_enabled, mcp_extra,
         last_shown_model, last_shown_effort, last_shown_agent)
      VALUES
        ('42', 1001, 'research', 7, 'session-1', '2026-06-01T00:00:00.000Z',
         'legacy prompt', 'sonnet', 1, 1, 'high', 1, 1, 'hermes',
         '["wiki"]', '{"custom":true}', 'sonnet', 'high', 'hermes');
    `);
    legacy.close();

    execFileSync(process.execPath, ["-e", 'await import("./src/storage/forum/schema.ts");'], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, SESSIONS_DB_PATH: dbPath },
      stdio: "pipe",
    });

    const migrated = new Database(dbPath);
    const topicSql = migrated
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='topics'",
      )
      .get()?.sql;
    expect(topicSql).toContain("PRIMARY KEY (user_id, name)");
    expect(topicSql).not.toContain("forum_group_id");

    const topicCols = migrated
      .query<{ name: string }, []>("PRAGMA table_info(topics)")
      .all()
      .map((c) => c.name);
    expect(topicCols).toContain("description");
    expect(topicCols).toContain("mcp_enabled");
    expect(topicCols).not.toContain("forum_group_id");
    expect(topicCols).not.toContain("system_prompt_extra");
    expect(topicCols).not.toContain("model");
    expect(topicCols).not.toContain("effort");
    expect(topicCols).not.toContain("privacy_mode");
    expect(topicCols).not.toContain("advisor_enabled");
    expect(topicCols).not.toContain("agent_settings");

    const userCols = migrated
      .query<{ name: string }, []>("PRAGMA table_info(users)")
      .all()
      .map((c) => c.name);
    expect(userCols).not.toContain("manager_session_id");

    const row = migrated
      .query<
        {
          description: string | null;
          agent: string | null;
          mcp_enabled: string | null;
          mcp_extra: string | null;
          last_shown_agent: string | null;
        },
        []
      >(
        "SELECT description, agent, mcp_enabled, mcp_extra, last_shown_agent FROM topics WHERE user_id = '42' AND name = 'research'",
      )
      .get();
    expect(row).toEqual({
      description: "legacy prompt",
      agent: "maestro",
      mcp_enabled: '["wiki"]',
      mcp_extra: '{"custom":true}',
      last_shown_agent: "hermes",
    });

    expect(() =>
      migrated
        .query(
          `INSERT INTO topics
            (user_id, name, message_thread_id, session_id, created_at, agent)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("42", "new-topic", 8, null, "2026-06-02T00:00:00.000Z", "claude"),
    ).not.toThrow();
    migrated.close();
  });
});
