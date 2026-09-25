/**
 * Regression (CI run 36156534788, Linux + Bun 1.2.15): the verified backup was
 * opened as `file:<path>?immutable=1`. Bun's bundled SQLite on Linux has no
 * URI support, so every `--apply` failed with "backup failed (nothing
 * changed): unable to open database file" — while macOS (system SQLite, URIs
 * enabled) passed. `openBackupReadOnly` must work with a plain path and keep
 * what `immutable=1` guaranteed: read-only, int64-exact, no sidecars created.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openBackupReadOnly } = await import("@/commands/admin/apply-env");

const BIG = 9007199254740993n; // 2^53 + 1

function walSourceWithBackup(): { dir: string; backup: string } {
  const dir = mkdtempSync(join(tmpdir(), "negotium-admin-backup-open-"));
  const source = new Database(join(dir, "source.db"), { safeIntegers: true });
  source.exec("PRAGMA journal_mode = WAL");
  source.exec("CREATE TABLE t (v INTEGER NOT NULL)");
  source.query("INSERT INTO t (v) VALUES (?)").run(BIG);
  const staging = mkdtempSync(join(dir, ".staging-"));
  const backup = join(staging, "backup.db");
  source.query("VACUUM INTO ?").run(backup);
  source.close();
  return { dir, backup };
}

describe("admin backup: opened without SQLite URIs", () => {
  test("a VACUUM INTO copy of a WAL database opens read-only, int64-exact, with no sidecars", () => {
    const { backup } = walSourceWithBackup();
    const before = readFileSync(backup);
    const db = openBackupReadOnly(backup);
    try {
      expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(db.query("SELECT v FROM t").get()).toEqual({ v: BIG });
      expect(() => db.exec("INSERT INTO t (v) VALUES (1)")).toThrow();
    } finally {
      db.close();
    }
    expect(readdirSync(join(backup, ".."))).toEqual(["backup.db"]);
    expect(readFileSync(backup).equals(before)).toBe(true);
  });

  test("refuses a WAL-mode file and a file with a sidecar next to it", () => {
    const { dir, backup } = walSourceWithBackup();
    const wal = new Database(join(dir, "wal.db"));
    wal.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v INTEGER)");
    wal.close();
    expect(() => openBackupReadOnly(join(dir, "wal.db"))).toThrow(
      /not a rollback-journal database/,
    );

    writeFileSync(`${backup}-journal`, "");
    expect(() => openBackupReadOnly(backup)).toThrow(/sidecar/);

    writeFileSync(join(dir, "not-sqlite.db"), "x".repeat(200));
    expect(() => openBackupReadOnly(join(dir, "not-sqlite.db"))).toThrow(/not an SQLite database/);
  });

  test("no admin source opens SQLite through a file: URI (unsupported by Bun on Linux)", () => {
    const srcDir = join(import.meta.dir, "..", "src", "commands", "admin");
    for (const name of readdirSync(srcDir).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(srcDir, name), "utf8");
      expect({ name, uri: /new Database\(\s*`file:/.test(text) }).toEqual({ name, uri: false });
    }
  });
});
