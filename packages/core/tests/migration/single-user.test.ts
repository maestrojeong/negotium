import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSingleUserState } from "#migration/single-user";
import { Database } from "#storage/sqlite";
import { decryptVaultValue, encryptVaultValue } from "#storage/vault-crypto";

const roots: string[] = [];

function root(): string {
  const value = join(tmpdir(), `negotium-single-user-${randomUUID()}`);
  roots.push(value);
  mkdirSync(value, { recursive: true });
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function options(stateDir: string, sourcePrincipal = "alice") {
  return {
    stateDir,
    sourcePrincipal,
    deleteOtherUsers: true,
    confirmed: true,
  } as const;
}

describe("0.2 single-user migration", () => {
  test("moves selected files, deletes other owners, canonicalizes DB identity, and preserves process owners", () => {
    const stateDir = root();
    mkdirSync(join(stateDir, "data", "conversations", "alice"), {
      recursive: true,
    });
    mkdirSync(join(stateDir, "data", "conversations", "bob"), {
      recursive: true,
    });
    mkdirSync(join(stateDir, "run"), { recursive: true });
    mkdirSync(join(stateDir, "workspace", "topics", "kept-topic"), {
      recursive: true,
    });
    mkdirSync(join(stateDir, "workspace", "topics", "other-topic"), {
      recursive: true,
    });
    writeFileSync(join(stateDir, "data", "conversations", "alice", "topic.jsonl"), "selected\n");
    writeFileSync(join(stateDir, "data", "conversations", "bob", "other.jsonl"), "deleted\n");
    writeFileSync(join(stateDir, "run", "progress.json"), "{}\n");
    writeFileSync(join(stateDir, "node-control-token"), "secret\n", {
      mode: 0o644,
    });
    const masterKey = Buffer.alloc(32, 7).toString("base64url");
    writeFileSync(join(stateDir, "vault-master-key"), `${masterKey}\n`, {
      mode: 0o600,
    });
    const dbPath = join(stateDir, "data", "sessions.db");
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE topics (user_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(user_id, name));
      CREATE TABLE runtime_process_leases (role TEXT NOT NULL, owner_id TEXT PRIMARY KEY, pid INTEGER NOT NULL);
      CREATE TABLE api_topics (id TEXT PRIMARY KEY, browser_profile TEXT, browser_profile_owner TEXT);
      CREATE TABLE topic_members (topic_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(topic_id, user_id));
      CREATE TABLE negotium_cron_jobs (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, topic_id TEXT NOT NULL);
      INSERT INTO users VALUES ('alice'), ('bob');
      INSERT INTO topics VALUES ('alice', 'kept'), ('bob', 'removed');
      INSERT INTO runtime_process_leases VALUES ('adapter:test', 'process:abc', 123);
      INSERT INTO api_topics VALUES ('kept-topic', 'work', 'alice'), ('other-topic', 'private', 'bob');
      INSERT INTO topic_members VALUES ('kept-topic', 'alice'), ('other-topic', 'bob');
      INSERT INTO negotium_cron_jobs VALUES ('kept-job', 'alice', 'kept-topic'), ('other-job', 'bob', 'other-topic');
    `);
    db.close();
    const legacyVault = new Database(join(stateDir, "data", "vault.db"), {
      create: true,
    });
    legacyVault.exec(
      "CREATE TABLE vault (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', PRIMARY KEY(user_id, key))",
    );
    legacyVault
      .query("INSERT INTO vault VALUES (?, ?, ?, '')")
      .run("alice", "TOKEN", encryptVaultValue("alice", "TOKEN", "selected-secret", masterKey));
    legacyVault
      .query("INSERT INTO vault VALUES (?, ?, ?, '')")
      .run("bob", "TOKEN", encryptVaultValue("bob", "TOKEN", "deleted-secret", masterKey));
    legacyVault.close();

    const result = migrateSingleUserState(options(stateDir));
    expect(result.status).toBe("completed");
    expect(readFileSync(join(stateDir, "data", "conversations", "topic.jsonl"), "utf8")).toBe(
      "selected\n",
    );
    expect(existsSync(join(stateDir, "data", "conversations", "bob"))).toBe(false);
    expect(existsSync(join(stateDir, "runtime", "progress.json"))).toBe(true);
    expect(existsSync(join(stateDir, "workspace", "topics", "kept-topic"))).toBe(true);
    expect(existsSync(join(stateDir, "workspace", "topics", "other-topic"))).toBe(false);
    expect(statSync(join(stateDir, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "secrets", "node-control-token")).mode & 0o777).toBe(0o600);
    const migrated = new Database(dbPath);
    expect(migrated.query<{ id: string }, []>("SELECT id FROM users").all()).toEqual([
      { id: "local" },
    ]);
    expect(migrated.query<{ user_id: string }, []>("SELECT user_id FROM topics").all()).toEqual([
      { user_id: "local" },
    ]);
    expect(
      migrated.query<{ owner_id: string }, []>("SELECT owner_id FROM runtime_process_leases").get()
        ?.owner_id,
    ).toBe("process:abc");
    expect(migrated.query<{ id: string }, []>("SELECT id FROM api_topics").all()).toEqual([
      { id: "kept-topic" },
    ]);
    expect(
      migrated
        .query<{ browser_profile_owner: string }, []>(
          "SELECT browser_profile_owner FROM api_topics WHERE id = 'kept-topic'",
        )
        .get()?.browser_profile_owner,
    ).toBe("local");
    expect(
      migrated
        .query<{ id: string; owner_user_id: string }, []>(
          "SELECT id, owner_user_id FROM negotium_cron_jobs",
        )
        .all(),
    ).toEqual([{ id: "kept-job", owner_user_id: "local" }]);
    migrated.close();
    const migratedVault = new Database(join(stateDir, "data", "vault", "vault.db"));
    const vaultRow = migratedVault
      .query<{ user_id: string; key: string; value: string }, []>(
        "SELECT user_id, key, value FROM vault",
      )
      .get();
    expect(vaultRow?.user_id).toBe("local");
    expect(decryptVaultValue("local", vaultRow!.key, vaultRow!.value, masterKey).value).toBe(
      "selected-secret",
    );
    migratedVault.close();
  });

  test("is idempotent after its machine-readable marker", () => {
    const stateDir = root();
    const first = migrateSingleUserState(options(stateDir, "local"));
    const second = migrateSingleUserState(options(stateDir, "local"));
    expect(first.status).toBe("completed");
    expect(second.status).toBe("already-completed");
    expect(JSON.parse(readFileSync(first.markerPath, "utf8")).canonicalPrincipal).toBe("local");
  });

  test("refuses unknown destination collisions and active processes without mutation", () => {
    const stateDir = root();
    mkdirSync(join(stateDir, "data", "users", "alice"), { recursive: true });
    writeFileSync(join(stateDir, "data", "users", "alice", "profile.json"), "source");
    writeFileSync(join(stateDir, "data", "users", "profile.json"), "destination");
    expect(() => migrateSingleUserState(options(stateDir))).toThrow("collision");
    expect(readFileSync(join(stateDir, "data", "users", "alice", "profile.json"), "utf8")).toBe(
      "source",
    );

    const activeDir = root();
    mkdirSync(join(activeDir, "run"), { recursive: true });
    writeFileSync(join(activeDir, "run", "node-daemon.json"), JSON.stringify({ pid: process.pid }));
    expect(() => migrateSingleUserState(options(activeDir))).toThrow("active");
  });

  test("merges state written by 0.2 before the legacy migration runs", () => {
    const stateDir = root();
    const ownerDir = `alice_${createHash("sha256").update("alice").digest("hex").slice(0, 16)}`;

    mkdirSync(join(stateDir, "run", "session-asks"), { recursive: true });
    mkdirSync(join(stateDir, "runtime", "session-asks"), { recursive: true });
    writeFileSync(join(stateDir, "run", "session-asks", "legacy"), "legacy-runtime");
    writeFileSync(join(stateDir, "runtime", "session-asks", "current"), "current-runtime");

    mkdirSync(join(stateDir, "bin", "browser-rs"), { recursive: true });
    mkdirSync(join(stateDir, "binaries", "browser-rs"), { recursive: true });
    writeFileSync(join(stateDir, "bin", "browser-rs", "legacy"), "legacy-binary");
    writeFileSync(join(stateDir, "binaries", "browser-rs", "current"), "current-binary");

    mkdirSync(join(stateDir, "secrets"), { recursive: true });
    writeFileSync(join(stateDir, "node-control-token"), "legacy-secret");
    writeFileSync(join(stateDir, "secrets", "node-control-token"), "current-secret");

    mkdirSync(join(stateDir, "data", "conversations", "alice"), {
      recursive: true,
    });
    writeFileSync(join(stateDir, "data", "conversations", "alice", "topic.jsonl"), "a\nb\n");
    writeFileSync(join(stateDir, "data", "conversations", "topic.jsonl"), "b\nc\n");

    mkdirSync(join(stateDir, "data", "tasks", "alice"), { recursive: true });
    writeFileSync(
      join(stateDir, "data", "tasks", "alice", "topic.json"),
      JSON.stringify({ version: 1, tasks: [{ id: "1", subject: "legacy" }] }),
    );
    writeFileSync(
      join(stateDir, "data", "tasks", "topic.json"),
      JSON.stringify({
        version: 1,
        tasks: [
          { id: "1", subject: "current" },
          { id: "2", subject: "dependent", blockedBy: ["1"] },
        ],
      }),
    );

    mkdirSync(join(stateDir, "workspace", "browser-profiles", "profiles", ownerDir, "default"), {
      recursive: true,
    });
    mkdirSync(join(stateDir, "browser", "profiles", "default"), {
      recursive: true,
    });
    writeFileSync(
      join(stateDir, "workspace", "browser-profiles", "profiles", ownerDir, "default", "state"),
      "legacy-browser",
    );
    writeFileSync(join(stateDir, "browser", "profiles", "default", "state"), "current-browser");

    const result = migrateSingleUserState(options(stateDir));
    expect(result.status).toBe("completed");
    expect(readFileSync(join(stateDir, "runtime", "session-asks", "current"), "utf8")).toBe(
      "current-runtime",
    );
    expect(existsSync(join(stateDir, "runtime", "session-asks", "legacy"))).toBe(false);
    expect(readFileSync(join(stateDir, "binaries", "browser-rs", "current"), "utf8")).toBe(
      "current-binary",
    );
    expect(readFileSync(join(stateDir, "secrets", "node-control-token"), "utf8")).toBe(
      "legacy-secret",
    );
    expect(readFileSync(join(stateDir, "data", "conversations", "topic.jsonl"), "utf8")).toBe(
      "a\nb\nc\n",
    );
    expect(
      JSON.parse(readFileSync(join(stateDir, "data", "tasks", "topic.json"), "utf8")).tasks,
    ).toEqual([
      { id: "1", subject: "legacy" },
      { id: "2", subject: "current" },
      { id: "3", subject: "dependent", blockedBy: ["2"] },
    ]);
    expect(readFileSync(join(stateDir, "browser", "profiles", "default", "state"), "utf8")).toBe(
      "legacy-browser",
    );
    expect(existsSync(join(stateDir, "run"))).toBe(false);
    expect(existsSync(join(stateDir, "bin"))).toBe(false);
  });

  test("restores both sides of a merged collision when database migration fails", () => {
    const stateDir = root();
    mkdirSync(join(stateDir, "data", "conversations", "alice"), {
      recursive: true,
    });
    writeFileSync(join(stateDir, "data", "conversations", "alice", "topic.jsonl"), "legacy\n");
    writeFileSync(join(stateDir, "data", "conversations", "topic.jsonl"), "current\n");
    const db = new Database(join(stateDir, "data", "sessions.db"), {
      create: true,
    });
    db.exec(
      "CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('alice'), ('local');",
    );
    db.close();

    expect(() => migrateSingleUserState(options(stateDir))).toThrow("collision");
    expect(
      readFileSync(join(stateDir, "data", "conversations", "alice", "topic.jsonl"), "utf8"),
    ).toBe("legacy\n");
    expect(readFileSync(join(stateDir, "data", "conversations", "topic.jsonl"), "utf8")).toBe(
      "current\n",
    );
  });

  test("resumes when a crash happened after staging but before journal update", () => {
    const stateDir = root();
    const staging = join(stateDir, ".migration-0.2.0-staging");
    const staged = join(staging, "already-moved");
    const source = join(stateDir, "run", "entry");
    const destination = join(stateDir, "runtime", "entry");
    mkdirSync(staging, { recursive: true });
    writeFileSync(staged, "payload");
    writeFileSync(
      join(staging, "journal.json"),
      JSON.stringify({
        id: "negotium-0.2.0-single-user",
        sourcePrincipal: "local",
        createdAt: new Date().toISOString(),
        phase: "filesystem",
        operations: [{ source, staged, destination, state: "pending" }],
      }),
    );
    const result = migrateSingleUserState(options(stateDir, "local"));
    expect(result.status).toBe("completed");
    expect(readFileSync(destination, "utf8")).toBe("payload");
  });

  test("resumes when a crash happened after destination placement", () => {
    const stateDir = root();
    const staging = join(stateDir, ".migration-0.2.0-staging");
    const source = join(stateDir, "run", "entry");
    const staged = join(staging, "already-placed");
    const destination = join(stateDir, "runtime", "entry");
    mkdirSync(staging, { recursive: true });
    mkdirSync(join(stateDir, "runtime"), { recursive: true });
    writeFileSync(destination, "payload");
    writeFileSync(
      join(staging, "journal.json"),
      JSON.stringify({
        id: "negotium-0.2.0-single-user",
        sourcePrincipal: "local",
        createdAt: new Date().toISOString(),
        phase: "filesystem",
        operations: [{ source, staged, destination, state: "destination-staged" }],
      }),
    );

    const result = migrateSingleUserState(options(stateDir, "local"));
    expect(result.status).toBe("completed");
    expect(readFileSync(destination, "utf8")).toBe("payload");
  });

  test("requires explicit destructive confirmation", () => {
    const stateDir = root();
    expect(() =>
      migrateSingleUserState({
        stateDir,
        deleteOtherUsers: true,
        confirmed: false,
      }),
    ).toThrow("--yes");
    chmodSync(stateDir, 0o700);
  });
});
