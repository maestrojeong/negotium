import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "#storage/sqlite";
import {
  configuredStorageDatabase,
  configureStorageHost,
  resolveStorageDataDir,
} from "#storage/storage-host";

/**
 * Regression cover for embedded Negotium writing into its own state directory
 * instead of the host's.
 *
 * The failure mode has no symptom: both databases are valid and writable, every
 * call succeeds, and the process simply keeps half its state in each. It was
 * found by noticing stray file handles in `lsof`, not by anything failing, so
 * these tests exist to make the next regression loud.
 *
 * The session-comm half of the fix is covered in
 * `tests/mcp/session-comm/topics.test.ts` instead: importing that module here
 * would freeze its argv-derived `userId` before that suite can set it.
 */

const cleanups: Array<() => void> = [];
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "negotium-host-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host database injection", () => {
  test("configuredStorageDatabase reports the injected connection without opening one", () => {
    const dir = tempDir();
    const hostDb = new Database(join(dir, "host.db"), { create: true });
    cleanups.push(() => hostDb.close());
    cleanups.push(configureStorageHost({ database: hostDb, dataDir: dir }));

    expect(configuredStorageDatabase()).toBe(hostDb);
    expect(resolveStorageDataDir()).toBe(dir);
  });

  test("disposing a host layer restores the previous one", () => {
    // Layering is how nested embeddings and scoped test overrides work, so the
    // borrow in withDb has to follow the *current* top of the stack, not the
    // first one ever installed.
    const dir = tempDir();
    const first = new Database(join(dir, "first.db"), { create: true });
    const second = new Database(join(dir, "second.db"), { create: true });
    cleanups.push(() => {
      first.close();
      second.close();
    });
    cleanups.push(configureStorageHost({ database: first, dataDir: dir }));
    const disposeSecond = configureStorageHost({ database: second, dataDir: dir });

    expect(configuredStorageDatabase()).toBe(second);

    disposeSecond();
    expect(configuredStorageDatabase()).toBe(first);
  });
});
