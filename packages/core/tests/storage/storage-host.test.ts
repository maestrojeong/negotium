import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getGlobalAiName, setGlobalAiName } from "#storage/app-settings";
import "#storage/api-messages";
import "#storage/api-topics";
import { flushSessionCache, getAllUserIds } from "#storage/forum/index";
import { db } from "#storage/forum-db";
import { createPendingAsk } from "#storage/session-asks";
import {
  closeStorageDatabase,
  configureStorageHost,
  resetStorageHost,
  resolveStorageDatabase,
  resolveStorageDataDir,
  resolveStorageLogDir,
  resolveStorageSessionAsksDir,
  resolveStorageSharedWikiDir,
  resolveStorageUsersLogDir,
  resolveStorageWorkspaceDir,
  type StorageDatabase,
} from "#storage/storage-host";
import { getTaskFilePath, writeTasks } from "#storage/tasks";
import { getStats, recordUsage, tokenStatsFileId } from "#storage/token-stats";
import { getSharedWikiDir } from "#storage/wiki";

const tempDirs: string[] = [];
const disposers: Array<() => void> = [];
const databases: Database[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "negotium-storage-host-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  resetStorageHost();
  closeStorageDatabase();
  for (const database of databases.splice(0)) database.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("storage host", () => {
  test("resolves injected paths lazily and restores nested hosts", () => {
    const root = tempRoot();
    const first = {
      dataDir: join(root, "data-a"),
      logDir: join(root, "logs-a"),
      sessionAsksDir: join(root, "asks-a"),
      workspaceDir: join(root, "workspace-a"),
    };
    const disposeFirst = configureStorageHost(first);
    disposers.push(disposeFirst);

    expect(resolveStorageDataDir()).toBe(first.dataDir);
    expect(resolveStorageLogDir()).toBe(first.logDir);
    expect(resolveStorageSessionAsksDir()).toBe(first.sessionAsksDir);
    expect(resolveStorageWorkspaceDir()).toBe(first.workspaceDir);
    expect(getSharedWikiDir()).toBe(join(first.workspaceDir, "wiki"));
    expect(existsSync(first.dataDir)).toBe(false);

    const secondDataDir = join(root, "data-b");
    const disposeSecond = configureStorageHost({ dataDir: secondDataDir });
    disposers.push(disposeSecond);
    expect(resolveStorageDataDir()).toBe(secondDataDir);
    expect(resolveStorageLogDir()).toBe(first.logDir);

    disposeSecond();
    disposers.pop();
    expect(resolveStorageDataDir()).toBe(first.dataDir);
  });

  test("pins relative paths at configure time and supports exact path overrides", () => {
    const relativeRoot = `tmp/storage-host-${randomUUID()}`;
    const dispose = configureStorageHost({
      dataDir: relativeRoot,
      sharedWikiDir: `${relativeRoot}/shared-wiki`,
      usersLogDir: `${relativeRoot}/user-logs`,
    });
    disposers.push(dispose);

    expect(resolveStorageDataDir()).toBe(resolve(relativeRoot));
    expect(resolveStorageSharedWikiDir()).toBe(resolve(relativeRoot, "shared-wiki"));
    expect(resolveStorageUsersLogDir()).toBe(resolve(relativeRoot, "user-logs"));
  });

  test("recomputes active layers when disposers run out of order", () => {
    const root = tempRoot();
    const disposeData = configureStorageHost({ dataDir: join(root, "data") });
    const disposeLog = configureStorageHost({ logDir: join(root, "logs") });
    disposers.push(disposeData, disposeLog);

    disposeData();
    expect(resolveStorageDataDir()).not.toBe(join(root, "data"));
    expect(resolveStorageLogDir()).toBe(join(root, "logs"));

    disposeLog();
    expect(resolveStorageLogDir()).not.toBe(join(root, "logs"));
  });

  test("accepts a structural database without taking ownership", () => {
    const statement = {
      get: () => undefined,
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    };
    const structuralDatabase: StorageDatabase = {
      query: () => statement,
      prepare: () => statement,
      exec: () => undefined,
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      transaction: (fn: (...args: any[]) => any) =>
        Object.assign(fn, {
          deferred: fn,
          immediate: fn,
          exclusive: fn,
        }),
    };
    const dispose = configureStorageHost({ database: structuralDatabase });
    disposers.push(dispose);
    expect(resolveStorageDatabase() as object).toBe(structuralDatabase);
  });

  test("places and switches the owned fallback database under the active data root", () => {
    const root = tempRoot();
    const previousDatabasePath = process.env.SESSIONS_DB_PATH;
    delete process.env.SESSIONS_DB_PATH;
    try {
      const firstDataDir = join(root, "first-data");
      const disposeFirst = configureStorageHost({ dataDir: firstDataDir });
      db.query("SELECT 1").get();
      expect(existsSync(join(firstDataDir, "sessions.db"))).toBe(true);
      disposeFirst();

      const secondDataDir = join(root, "second-data");
      const disposeSecond = configureStorageHost({ dataDir: secondDataDir });
      disposers.push(disposeSecond);
      db.query("SELECT 1").get();
      expect(existsSync(join(secondDataDir, "sessions.db"))).toBe(true);
    } finally {
      if (previousDatabasePath === undefined) delete process.env.SESSIONS_DB_PATH;
      else process.env.SESSIONS_DB_PATH = previousDatabasePath;
    }
  });

  test("routes file-backed stores through the configured host", () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const logDir = join(root, "logs");
    const sessionAsksDir = join(root, "asks");
    disposers.push(configureStorageHost({ dataDir, logDir, sessionAsksDir }));

    writeTasks("host-user", "host-topic", []);
    expect(getTaskFilePath("host-user", "host-topic").startsWith(dataDir)).toBe(true);

    setGlobalAiName("Hostium");
    expect(getGlobalAiName()).toBe("Hostium");
    expect(existsSync(join(dataDir, "otium-settings.json"))).toBe(true);

    recordUsage("host-user", "host-topic", { inputTokens: 2, outputTokens: 1 });
    expect(getStats("host-user").total.queries).toBe(1);
    expect(readdirSync(logDir)).toEqual(["token-queries-host-user.jsonl"]);
    expect(tokenStatsFileId("tenant..escape")).toMatch(/^sha256-[a-f0-9]{64}$/);

    expect(
      createPendingAsk({
        userId: "host-user",
        from: "caller",
        to: "target",
        requestId: "host-request",
      }).ok,
    ).toBe(true);
    expect(readdirSync(join(sessionAsksDir, "host-user"))).toEqual([
      expect.stringMatching(/^v3-[a-f0-9]{64}\.pending$/),
    ]);
  });

  test("initializes every schema per injected database and never closes borrowed connections", () => {
    const first = new Database(":memory:");
    const second = new Database(":memory:");
    databases.push(first, second);

    const disposeFirst = configureStorageHost({ database: first });
    expect(getAllUserIds()).toEqual([]);
    expect(
      first
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='api_messages'",
        )
        .get()?.name,
    ).toBe("api_messages");
    flushSessionCache();
    expect(first.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    disposeFirst();

    const disposeSecond = configureStorageHost({ database: second });
    expect(db.query("PRAGMA table_info(api_topics)").all().length).toBeGreaterThan(0);
    expect(second.query("PRAGMA foreign_key_check").all()).toEqual([]);
    disposeSecond();
  });

  test("migrates an existing Otium database without losing topic or message data", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE api_topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'channel',
        description TEXT,
        agent TEXT,
        default_model TEXT,
        default_effort TEXT,
        participants TEXT,
        created_at TEXT NOT NULL,
        last_message_at TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0,
        ai_mention INTEGER NOT NULL DEFAULT 0,
        ai_mode TEXT
      );
      CREATE TABLE api_messages (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        parent_id TEXT,
        author_id TEXT NOT NULL,
        text TEXT NOT NULL,
        query_id TEXT,
        agent_type TEXT,
        model TEXT,
        attachments TEXT,
        usage TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        edited_at TEXT,
        reactions TEXT,
        kind TEXT,
        ask_user_question TEXT,
        mentions TEXT,
        thread_root_id TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO api_topics (
        id, title, kind, agent, default_model, default_effort, participants, created_at
      ) VALUES (
        'otium-topic', 'Otium topic', 'agent', 'codex', 'gpt-5', 'high', '["otium-user"]',
        '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO api_messages (id, topic_id, author_id, text, created_at)
      VALUES (
        'otium-message', 'otium-topic', 'otium-user', 'preserve me',
        '2026-01-01T00:00:01.000Z'
      );
    `);

    const dispose = configureStorageHost({ database });
    disposers.push(dispose);
    expect(getAllUserIds()).toEqual([]);
    expect(db.query("SELECT title FROM api_topics WHERE id = ?").get("otium-topic")).toEqual({
      title: "Otium topic",
    });
    expect(db.query("SELECT text FROM api_messages WHERE id = ?").get("otium-message")).toEqual({
      text: "preserve me",
    });
    const topicColumns = db.query("PRAGMA table_info(api_topics)").all() as Array<{ name: string }>;
    const messageColumns = db.query("PRAGMA table_info(api_messages)").all() as Array<{
      name: string;
    }>;
    expect(topicColumns.map((column) => column.name)).toContain("base_model");
    expect(messageColumns.map((column) => column.name)).toContain("source_adapter");
    expect(messageColumns.map((column) => column.name)).toContain("subagent_card");

    // Schema initialization is per connection and safe to invoke repeatedly.
    expect(getAllUserIds()).toEqual([]);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
