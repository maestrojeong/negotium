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

/**
 * The canonical `api_topics` schema exactly as a node created it before
 * `derived_by_user_id` existed (the `createCanonicalTopicsTable` shape plus the
 * additive `subagent_report_mode` column that shipped earlier). The in-process
 * test database is always freshly created with every column, so it can never
 * exercise the ALTER; this one does, in a child process pointed at the old file.
 */
const OLD_SCHEMA = `
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
  INSERT INTO api_topics (id, title, kind, agent, base_model, base_effort, response_policy, created_at, last_message_at, surface)
  VALUES ('legacy-room', 'Legacy room', 'agent', 'codex', 'gpt-6-luna', 'medium', 'always',
          '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'otium');
  INSERT INTO topic_members (topic_id, user_id, role) VALUES ('legacy-room', 'local', 'owner');
`;

/**
 * Runs inside the child: open the old store through the real module (which
 * applies the ALTER on first access), then exercise the upsert semantics the
 * new column relies on and print what the store says afterwards.
 */
const CHILD_SCRIPT = `
  const { getTopic, upsertTopic } = await import("./src/storage/api-topics.ts");
  const legacy = getTopic("legacy-room");
  const now = new Date().toISOString();
  const room = {
    id: "derived-room",
    title: "Derived room",
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId: "local", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    surface: "otium",
    parentTopicId: "legacy-room",
    derivedByUserId: "person-1",
  };
  upsertTopic(room);
  const recorded = getTopic("derived-room")?.derivedByUserId;
  // A later update that omits the fact must not erase it (COALESCE).
  upsertTopic({ ...getTopic("derived-room"), title: "Derived room (renamed)", derivedByUserId: undefined });
  const retained = getTopic("derived-room");
  // But a room that never had one stays without one, and an explicit value on
  // a row that already has one is not overwritten either.
  upsertTopic({ ...getTopic("derived-room"), derivedByUserId: "person-2" });
  const afterConflict = getTopic("derived-room")?.derivedByUserId;
  console.log(JSON.stringify({
    legacyDerivedBy: legacy?.derivedByUserId ?? null,
    legacyTitle: legacy?.title ?? null,
    recorded,
    retained: retained?.derivedByUserId ?? null,
    retainedTitle: retained?.title ?? null,
    afterConflict,
  }));
`;

describe("api_topics derived_by_user_id migration", () => {
  test("adds the column to a real pre-existing schema and keeps the value across updates", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-api-topics-derived-by-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "sessions.db");
    const old = new Database(dbPath, { create: true });
    old.exec(OLD_SCHEMA);
    const before = old
      .query<{ name: string }, []>("PRAGMA table_info(api_topics)")
      .all()
      .map((column) => column.name);
    expect(before).not.toContain("derived_by_user_id");
    old.close();

    const output = execFileSync(process.execPath, ["-e", CHILD_SCRIPT], {
      cwd: join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        SESSIONS_DB_PATH: dbPath,
        NEGOTIUM_STATE_DIR: join(dir, "state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString("utf-8")
      .trim()
      .split("\n")
      .at(-1);
    expect(JSON.parse(output ?? "{}")).toEqual({
      // The pre-existing row survived the ALTER untouched and reads as "not derived".
      legacyDerivedBy: null,
      legacyTitle: "Legacy room",
      recorded: "person-1",
      retained: "person-1",
      retainedTitle: "Derived room (renamed)",
      // `COALESCE(excluded, existing)`: a later explicit value wins over the
      // stored one — the fact is only protected against being *omitted*.
      afterConflict: "person-2",
    });

    const migrated = new Database(dbPath);
    const after = migrated
      .query<{ name: string }, []>("PRAGMA table_info(api_topics)")
      .all()
      .map((column) => column.name);
    expect(after).toContain("derived_by_user_id");
    expect(
      migrated
        .query<{ derived_by_user_id: string | null }, [string]>(
          "SELECT derived_by_user_id FROM api_topics WHERE id = ?",
        )
        .get("legacy-room")?.derived_by_user_id,
    ).toBeNull();
    migrated.close();
  });
});
