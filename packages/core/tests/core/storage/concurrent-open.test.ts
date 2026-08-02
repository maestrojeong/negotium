import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Two Negotium processes routinely open the same database at the same moment —
 * the node daemon and an adapter, or several MCP servers coming up together.
 *
 * Switching a database to WAL takes a brief exclusive lock, so a simultaneous
 * opener gets SQLITE_BUSY. `initializeDatabase` therefore has to install
 * `busy_timeout` *before* `journal_mode`, or there is no retry budget in force
 * for the one statement that needs it and the loser dies with
 * "database is locked" during startup.
 *
 * This spawns real processes: the race is between OS-level file locks, which a
 * single-process test cannot produce.
 */
const OPENER = `
import { Database } from "bun:sqlite";
const { initializeDatabase } = await import(process.env.INIT_MODULE);
const handle = new Database(process.env.TARGET, { create: true });
try {
  initializeDatabase(handle);
  handle.exec("CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY)");
  console.log("OK");
} catch (e) {
  console.log("FAIL " + (e instanceof Error ? e.message : String(e)));
}
`;

const INIT_MODULE = new URL("../../../src/storage/storage-host.ts", import.meta.url).href;

test("concurrent processes can open and initialize the same database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "concurrent-open-"));
  const target = join(dir, "store.sqlite");
  try {
    // Four at once against one *fresh* file: every one of them races to be the
    // process that performs the WAL switch.
    const openers = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "-e", OPENER], {
        env: { ...process.env, TARGET: target, INIT_MODULE },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(openers.map((o) => new Response(o.stdout).text()));

    // Before the pragma order was corrected this failed roughly 60% of the time
    // with "database is locked".
    expect(results.map((r) => r.trim())).toEqual(["OK", "OK", "OK", "OK"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
