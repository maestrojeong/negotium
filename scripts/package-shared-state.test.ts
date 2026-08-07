import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The published package must expose **one** storage host per process.
 *
 * `configureStorageHost()` installs the database an embedding host wants
 * Negotium to use. That registry is process-global state expressed as module
 * state, which only holds if every public entrypoint resolves to the same
 * module instance. `build-negotium-package.ts` builds most entrypoints as
 * independent graphs with `splitting = false`, and its comment claims they "do
 * not share mutable runtime registrations with one another" — for storage that
 * was false.
 *
 * When it breaks, an embedded Negotium configures the copy inside
 * `negotium/storage`, then some other entrypoint's copy sees an unconfigured
 * host and opens a second database under the default state directory. Nothing
 * errors: both files are valid and writable, so the process just splits its
 * state in two. It was found by noticing stray handles in `lsof`, not by
 * anything failing — hence assertions against built output, not source.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/negotium");
const dist = resolve(packageRoot, "dist");
const DB_FILENAME = ["sessions", "db"].join(".");

/** Public entrypoints that can reach storage and are used together by a host. */
const STORAGE_ENTRYPOINTS = [
  "storage.js",
  "agent-helpers.js",
  "mcp-factories.js",
  "query-runtime.js",
  "runtime-helpers.js",
  "browser-runtime.js",
  "vault.js",
] as const;

const built = existsSync(dist) && existsSync(join(dist, "storage.js"));
const describeBuilt = built ? describe : describe.skip;

describeBuilt("published package storage host", () => {
  test("a second entrypoint does not open its own database after a host is configured", async () => {
    // Mirrors the real failure: Otium configures the host through
    // `negotium/storage`, then reaches storage again through
    // `negotium/agent-helpers` (ask-user → process leases). If that entrypoint
    // holds its own registry it sees no host and quietly opens a database in
    // the default state directory instead.
    const dir = await mkdtemp(join(tmpdir(), "negotium-shared-state-"));
    const stateDir = join(dir, "state");
    try {
      const probe = join(dir, "probe.mjs");
      await writeFile(
        probe,
        `import { Database } from "bun:sqlite";
import { configureStorageHost } from ${JSON.stringify(join(dist, "storage.js"))};
import { defaultAskUserDurabilityHost } from ${JSON.stringify(join(dist, "agent-helpers.js"))};

const host = new Database(${JSON.stringify(join(dir, "host.db"))}, { create: true });
configureStorageHost({ database: host, dataDir: ${JSON.stringify(dir)} });

// Any touch is enough; the leak happens on the first storage resolution.
try {
  defaultAskUserDurabilityHost.processLeases.acquire?.("shared-state-probe", "probe");
} catch {
  // The call failing is fine — resolving a connection is what matters.
}
`,
        "utf8",
      );

      // Redirect the default location so a leak lands somewhere observable
      // rather than in the developer's real state directory. The more specific
      // overrides must be cleared too: the repo test preload sets
      // `SESSIONS_DB_PATH`, and inheriting it would send the leak to the shared
      // test root instead of here, making this assertion vacuous.
      const env = { ...process.env, NEGOTIUM_STATE_DIR: stateDir };
      for (const key of ["SESSIONS_DB_PATH", "NEGOTIUM_DATA_DIR"]) delete env[key];

      const run = Bun.spawnSync(["bun", probe], { stdout: "pipe", stderr: "pipe", env });
      expect(new TextDecoder().decode(run.stderr)).toBe("");

      // The whole bug in one assertion: once a host database is injected,
      // nothing may appear in the default state directory.
      expect(existsSync(join(stateDir, "data", DB_FILENAME))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no entrypoint carries a private copy of the host registry", async () => {
    // Structural backstop for the behavioural test above: two bundles each
    // declaring the registry is exactly the duplication that splits the store.
    const owners: string[] = [];
    for (const name of STORAGE_ENTRYPOINTS) {
      const file = join(dist, name);
      if (!existsSync(file)) continue;
      const source = await readFile(file, "utf8");
      // The declaration, not references — references also appear in a bundle
      // that merely imports the shared chunk.
      if (/\b(?:let|var|const)\s+configuredHost\b/.test(source)) owners.push(name);
    }
    // Zero is the healthy result: the registry lives in a chunk every
    // entrypoint imports. One is tolerable (a single entrypoint owning it and
    // the rest importing from there). Two or more is the split store.
    expect(owners.length).toBeLessThanOrEqual(1);
  });
});
