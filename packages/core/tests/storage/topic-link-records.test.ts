import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeTopicLinkRecordsSchema,
  topicLinkPayloadHash,
} from "../../src/storage/topic-link-records";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The api_topics columns the tombstone triggers read. */
function memoryDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE api_topics (
      id TEXT PRIMARY KEY,
      surface TEXT NOT NULL DEFAULT 'terminal',
      surface_scope TEXT,
      visibility TEXT NOT NULL DEFAULT 'visible'
    );
    CREATE TABLE api_messages (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL);
  `);
  return db;
}

function tombstones(db: Database) {
  return db
    .query<
      { topic_id: string; node_id: string | null; reason: string; surface_scope: string | null },
      []
    >("SELECT topic_id, node_id, reason, surface_scope FROM api_topic_tombstones ORDER BY seq")
    .all();
}

function schemaObjects(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE name LIKE 'api_topic_%' OR name LIKE 'api_node_identity' OR name LIKE 'api_topics_tombstone_%'
       ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

describe("topic link schema", () => {
  test("is idempotent and refreshes the node identity without touching history", () => {
    const db = memoryDb();
    initializeTopicLinkRecordsSchema(db, "node-a");
    const objects = schemaObjects(db);
    expect(objects).toEqual(
      expect.arrayContaining([
        "api_node_identity",
        "api_topic_create_claims",
        "api_topic_tombstones",
        "api_topics_tombstone_on_delete",
        "api_topics_tombstone_on_unshare",
        "api_topics_tombstone_on_reshare",
        "api_topics_tombstone_on_insert",
      ]),
    );
    db.exec("INSERT INTO api_topics (id, surface) VALUES ('t1', 'otium')");
    db.exec("DELETE FROM api_topics WHERE id = 't1'");

    initializeTopicLinkRecordsSchema(db, "node-a");
    expect(schemaObjects(db)).toEqual(objects);
    expect(tombstones(db)).toEqual([
      { topic_id: "t1", node_id: "node-a", reason: "deleted", surface_scope: null },
    ]);

    // A store copied to another install: the old tombstone keeps the identity
    // it was written under; new ones get the new identity.
    initializeTopicLinkRecordsSchema(db, "node-b");
    db.exec("INSERT INTO api_topics (id, surface) VALUES ('t2', 'otium')");
    db.exec("DELETE FROM api_topics WHERE id = 't2'");
    expect(tombstones(db).map((row) => [row.topic_id, row.node_id])).toEqual([
      ["t1", "node-a"],
      ["t2", "node-b"],
    ]);
  });

  test("before any identity is recorded, tombstones carry NULL (never bindable)", () => {
    const db = memoryDb();
    initializeTopicLinkRecordsSchema(db);
    db.exec("INSERT INTO api_topics (id, surface) VALUES ('t1', 'otium')");
    db.exec("DELETE FROM api_topics WHERE id = 't1'");
    expect(tombstones(db)).toEqual([
      { topic_id: "t1", node_id: null, reason: "deleted", surface_scope: null },
    ]);
  });

  test("is all-or-nothing: a failing step leaves no partial schema behind", () => {
    // No api_topics table: the first trigger cannot be created.
    const db = new Database(":memory:");
    expect(() => initializeTopicLinkRecordsSchema(db, "node-a")).toThrow();
    expect(schemaObjects(db)).toEqual([]);
  });

  test("triggers tombstone deletes and unshares, and clear them on reshare/reinsert", () => {
    const db = memoryDb();
    initializeTopicLinkRecordsSchema(db, "node-a");
    db.exec(`
      INSERT INTO api_topics (id, surface, surface_scope) VALUES
        ('moved', 'otium', 'ws-1'), ('hidden', 'otium', 'ws-1'), ('term', 'terminal', NULL)
    `);
    db.exec("UPDATE api_topics SET surface = 'terminal' WHERE id = 'moved'");
    db.exec("UPDATE api_topics SET visibility = 'hidden' WHERE id = 'hidden'");
    // Not an Otium room: leaving nothing, no tombstone.
    db.exec("UPDATE api_topics SET visibility = 'hidden' WHERE id = 'term'");
    expect(tombstones(db)).toEqual([
      { topic_id: "moved", node_id: "node-a", reason: "unshared", surface_scope: "ws-1" },
      { topic_id: "hidden", node_id: "node-a", reason: "unshared", surface_scope: "ws-1" },
    ]);

    db.exec("UPDATE api_topics SET surface = 'otium' WHERE id = 'moved'");
    expect(tombstones(db).map((row) => row.topic_id)).toEqual(["hidden"]);

    // Deleting an unshared room upgrades its tombstone to a deletion.
    db.exec("DELETE FROM api_topics WHERE id = 'hidden'");
    expect(tombstones(db)).toEqual([
      { topic_id: "hidden", node_id: "node-a", reason: "deleted", surface_scope: "ws-1" },
    ]);

    db.exec("INSERT INTO api_topics (id, surface) VALUES ('hidden', 'otium')");
    expect(tombstones(db)).toEqual([]);
  });

  test("the delete tombstone is part of the deleting transaction", () => {
    const db = memoryDb();
    initializeTopicLinkRecordsSchema(db, "node-a");
    db.exec("INSERT INTO api_topics (id, surface) VALUES ('t1', 'otium')");
    expect(() =>
      db.transaction(() => {
        db.exec("DELETE FROM api_topics WHERE id = 't1'");
        throw new Error("crash after delete");
      })(),
    ).toThrow("crash after delete");
    expect(tombstones(db)).toEqual([]);
    expect(db.query("SELECT id FROM api_topics").all()).toEqual([{ id: "t1" }]);
  });
});

describe("topicLinkPayloadHash", () => {
  /** Verbatim copy of the hub's `linkPayloadHash` (otium link/link-intents.ts, PR6). */
  function hubCanonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(hubCanonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${hubCanonicalJson(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  }
  function hubLinkPayloadHash(body: Record<string, unknown>): string {
    const { requestId: _requestId, payloadHash: _payloadHash, ...payload } = body;
    return createHash("sha256").update(hubCanonicalJson(payload)).digest("hex");
  }

  const createBody = {
    v: 1,
    userId: "local",
    title: "Quarterly plan",
    kind: "agent",
    agent: "codex",
    model: "gpt-6-luna",
    effort: "medium",
    memoryKey: "plan",
  };

  test("matches the hub byte for byte, with and without the saga fields", () => {
    const bodies: Record<string, unknown>[] = [
      createBody,
      { ...createBody, requestId: "r-1", payloadHash: "whatever" },
      { v: 1, userId: "local", title: "Channel", kind: "channel", agent: null },
      // derive: the hub hashes `{ v, sourceTopicId, ...body }`
      { v: 1, sourceTopicId: "src-1", userId: "local", copyHistory: true, name: "Fork" },
      { nested: { b: [1, { z: 1, a: "é" }], a: null }, v: 1 },
    ];
    for (const body of bodies) expect(topicLinkPayloadHash(body)).toBe(hubLinkPayloadHash(body));
  });

  test("ignores key order and the saga fields, not values", () => {
    const shuffled = Object.fromEntries(Object.entries(createBody).reverse());
    expect(topicLinkPayloadHash(shuffled)).toBe(topicLinkPayloadHash(createBody));
    expect(topicLinkPayloadHash({ ...createBody, requestId: "x", payloadHash: "y" })).toBe(
      topicLinkPayloadHash(createBody),
    );
    expect(topicLinkPayloadHash({ ...createBody, title: "Other" })).not.toBe(
      topicLinkPayloadHash(createBody),
    );
  });

  test("pins a known vector so either side drifting is caught", () => {
    expect(topicLinkPayloadHash({ v: 1, userId: "local", title: "Hello", kind: "agent" })).toBe(
      createHash("sha256")
        .update('{"kind":"agent","title":"Hello","userId":"local","v":1}')
        .digest("hex"),
    );
  });
});

const LEGACY_SCHEMA = `
  CREATE TABLE api_topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('channel','agent','manager')),
    description TEXT,
    agent TEXT CHECK (agent IS NULL OR agent IN ('maestro','claude','codex')),
    base_model TEXT,
    base_effort TEXT CHECK (base_effort IS NULL OR base_effort IN ('low','medium','high','xhigh','max')),
    response_policy TEXT NOT NULL CHECK (response_policy IN ('off','mention','always')),
    created_at TEXT NOT NULL,
    last_message_at TEXT,
    parent_topic_id TEXT,
    memory_topic_id TEXT,
    memory_key TEXT,
    is_fork INTEGER NOT NULL DEFAULT 0 CHECK (is_fork IN (0,1)),
    is_subagent INTEGER NOT NULL DEFAULT 0 CHECK (is_subagent IN (0,1)),
    visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden')),
    surface TEXT NOT NULL DEFAULT 'terminal' CHECK (surface IN ('terminal','telegram','otium')),
    surface_scope TEXT,
    browser_profile TEXT NOT NULL DEFAULT 'default',
    browser_profile_owner TEXT,
    session_id TEXT,
    subagent_report_mode TEXT NOT NULL DEFAULT 'auto'
  );
  CREATE TABLE topic_members (
    topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    PRIMARY KEY (topic_id, user_id)
  );
  INSERT INTO api_topics (id, title, kind, agent, base_model, base_effort, response_policy, created_at, last_message_at, surface, surface_scope)
  VALUES ('legacy-a', 'Legacy A', 'agent', 'codex', 'gpt-5.6-luna', 'medium', 'always',
          '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'otium', 'ws-1'),
         ('legacy-b', 'Legacy B', 'agent', 'codex', 'gpt-5.6-luna', 'medium', 'always',
          '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'otium', 'ws-1');
  INSERT INTO topic_members (topic_id, user_id, role) VALUES ('legacy-a', 'local', 'owner'), ('legacy-b', 'local', 'owner');
`;

/** Opens the store through the real modules (runs every migration), then acts. */
const CHILD_SCRIPT = `
  const topics = await import("./src/storage/api-topics.ts");
  const records = await import("./src/storage/topic-link-records.ts");
  // What the node process does on its first gateway request.
  const { NODE_ID } = await import("./src/platform/config.ts");
  records.recordTopicLinkNodeIdentity(NODE_ID);
  const mode = process.env.CHILD_MODE;
  if (mode === "first") {
    topics.deleteTopic("legacy-a");
  }
  console.log(JSON.stringify({
    rooms: topics.listTopics().map((t) => t.id).sort(),
    identity: records.topicLinkNodeIdentity(),
    tombstone: records.getTopicTombstone("legacy-a"),
    untouched: records.getTopicTombstone("legacy-b"),
  }));
`;

describe("migration on a legacy database copy", () => {
  test("adds the tables and triggers to a pre-PR7 store, idempotently, without fabricating tombstones", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-topic-link-migration-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "sessions.db");
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(LEGACY_SCHEMA);
    legacy.close();

    const run = (mode: string) =>
      JSON.parse(
        execFileSync(process.execPath, ["-e", CHILD_SCRIPT], {
          cwd: join(import.meta.dir, "../.."),
          env: {
            ...process.env,
            SESSIONS_DB_PATH: dbPath,
            NEGOTIUM_STATE_DIR: join(dir, "state"),
            NEGOTIUM_NODE_ID: "legacy-node",
            // An Otium node: the one-time surface backfill keeps these rooms on otium.
            NEGOTIUM_DEFAULT_SURFACE: "otium",
            CHILD_MODE: mode,
          },
          stdio: ["ignore", "pipe", "pipe"],
        })
          .toString("utf-8")
          .trim()
          .split("\n")
          .at(-1) ?? "{}",
      );

    const first = run("first");
    expect(first.rooms).toEqual(["legacy-b"]);
    expect(first.identity).toBe("legacy-node");
    expect(first.tombstone).toMatchObject({
      topicId: "legacy-a",
      nodeId: "legacy-node",
      reason: "deleted",
      surface: "otium",
      surfaceScope: "ws-1",
    });
    // The migration itself wrote nothing about rows it merely found.
    expect(first.untouched).toBeNull();

    // Second boot on the same file: no error, history intact.
    const second = run("again");
    expect(second.rooms).toEqual(["legacy-b"]);
    expect(second.tombstone).toEqual(first.tombstone);
    expect(second.untouched).toBeNull();

    const migrated = new Database(dbPath);
    const tables = migrated
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('api_topic_create_claims','api_topic_tombstones','api_node_identity') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "api_node_identity",
      "api_topic_create_claims",
      "api_topic_tombstones",
    ]);
    migrated.close();
  });
});
