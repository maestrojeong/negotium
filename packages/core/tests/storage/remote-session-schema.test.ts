/**
 * The remote session-comm schema initializer (PR9 columns on top of the 0.20
 * tables): idempotent, read-only when current, all-or-nothing, and safe with
 * a second connection migrating the same file.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeRemoteSessionSchema } from "#storage/remote-session";

const dir = mkdtempSync(join(tmpdir(), "negotium-remote-session-schema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function freshPath(): string {
  n += 1;
  return join(dir, `db-${n}.sqlite`);
}

/** The 0.20.4 (main) shape: no `owner_token`, no `dispatch_state`. */
const MAIN_SHAPE = `
  CREATE TABLE remote_session_inbox_claims (
    request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, topic_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'completed', lease_until INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT
  );
  CREATE INDEX idx_remote_session_inbox_claims_created ON remote_session_inbox_claims(created_at);
  CREATE TABLE remote_session_asks (
    request_id TEXT PRIMARY KEY, caller_topic_id TEXT NOT NULL, user_id TEXT NOT NULL,
    from_key TEXT NOT NULL, to_key TEXT NOT NULL, caller_thread_root_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_remote_session_asks_caller ON remote_session_asks(caller_topic_id);
  CREATE TABLE remote_session_reply_outbox (
    request_id TEXT PRIMARY KEY, hub_url TEXT NOT NULL, token TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('reply', 'error')), reply_text TEXT NOT NULL,
    from_label TEXT NOT NULL, created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  INSERT INTO remote_session_inbox_claims (request_id, kind, topic_id, payload_hash, created_at)
    VALUES ('old-claim', 'tell', 't1', 'h', 1);
  INSERT INTO remote_session_asks (request_id, caller_topic_id, user_id, from_key, to_key, created_at)
    VALUES ('old-ask', 't1', 'local', 'a', 'b', 1);
`;

function open(path: string, readonly = false): Database {
  const db = readonly ? new Database(path, { readonly: true }) : new Database(path);
  if (!readonly) db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL");
  return db;
}

function columns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((r) => r.name)
    .sort();
}

const CLAIM_COLUMNS = [
  "created_at",
  "kind",
  "lease_until",
  "owner_token",
  "payload_hash",
  "payload_json",
  "request_id",
  "state",
  "topic_id",
];

describe("remote session-comm schema initializer", () => {
  test("empty DB: creates everything; a second run is a no-op", () => {
    const db = open(freshPath());
    initializeRemoteSessionSchema(db);
    expect(columns(db, "remote_session_inbox_claims")).toEqual(CLAIM_COLUMNS);
    expect(columns(db, "remote_session_asks")).toContain("dispatch_state");
    const before = db.query("SELECT total_changes() AS c").get();
    initializeRemoteSessionSchema(db);
    expect(db.query("SELECT total_changes() AS c").get()).toEqual(before);
    db.close();
  });

  test("main (0.20.4) shape: adds owner_token + dispatch_state and keeps rows with the documented defaults", () => {
    const db = open(freshPath());
    db.exec(MAIN_SHAPE);
    initializeRemoteSessionSchema(db);
    initializeRemoteSessionSchema(db);
    expect(columns(db, "remote_session_inbox_claims")).toEqual(CLAIM_COLUMNS);
    expect(
      db.query("SELECT state, owner_token FROM remote_session_inbox_claims").get(),
    ).toEqual({ state: "completed", owner_token: null });
    expect(db.query("SELECT dispatch_state FROM remote_session_asks").get()).toEqual({
      dispatch_state: "dispatched",
    });
    db.close();
  });

  test("a current schema is detected read-only (never takes the write lock)", () => {
    const path = freshPath();
    const writer = open(path);
    initializeRemoteSessionSchema(writer);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const reader = open(path, true);
    expect(() => initializeRemoteSessionSchema(reader)).not.toThrow();
    reader.close();
    writer.close();
    // An outdated schema on a read-only connection fails loudly instead of
    // being swallowed.
    const legacy = freshPath();
    const w2 = open(legacy);
    w2.exec(MAIN_SHAPE);
    w2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const r2 = open(legacy, true);
    expect(() => initializeRemoteSessionSchema(r2)).toThrow(/readonly/);
    r2.close();
    w2.close();
  });

  test("all-or-nothing: a failure on a later column rolls back the earlier ones", () => {
    const db = open(freshPath());
    db.exec(MAIN_SHAPE);
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === "exec") {
          return (sql: string) => {
            if (sql.includes("dispatch_state")) throw new Error("injected");
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => initializeRemoteSessionSchema(failing)).toThrow("injected");
    expect(columns(db, "remote_session_inbox_claims")).not.toContain("owner_token");
    initializeRemoteSessionSchema(db);
    expect(columns(db, "remote_session_inbox_claims")).toContain("owner_token");
    expect(columns(db, "remote_session_asks")).toContain("dispatch_state");
    db.close();
  });

  test("a second connection migrating the same file concurrently converges", async () => {
    const path = freshPath();
    const seed = open(path);
    seed.exec(MAIN_SHAPE);
    seed.close();
    const script = `
      const { Database } = await import("bun:sqlite");
      const { initializeRemoteSessionSchema } = await import(${JSON.stringify(
        join(import.meta.dir, "../../src/storage/remote-session.ts"),
      )});
      const db = new Database(${JSON.stringify(path)});
      db.exec("PRAGMA busy_timeout = 5000");
      initializeRemoteSessionSchema(db);
      db.close();
    `;
    const children = [0, 1, 2].map(() =>
      Bun.spawn([process.execPath, "-e", script], {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(children.map((c) => c.exited));
    const errors = await Promise.all(children.map((c) => new Response(c.stderr).text()));
    expect({ codes, errors: errors.filter(Boolean) }).toEqual({ codes: [0, 0, 0], errors: [] });
    const db = open(path);
    expect(columns(db, "remote_session_inbox_claims")).toEqual(CLAIM_COLUMNS);
    expect(columns(db, "remote_session_asks")).toContain("dispatch_state");
    db.close();
  });
});
