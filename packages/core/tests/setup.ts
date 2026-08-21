import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * background-bash spawns the bash-rs binary and has no in-repo substitute, but
 * the state dir is about to be redirected at a temp directory where nothing is
 * installed. Point the manager back at whatever the developer has installed so
 * the integration tests exercise a real server; the suite skips itself when
 * nothing is found rather than failing on an unprovisioned machine.
 */
function installedBashRs(): string | undefined {
  const root = join(homedir(), ".negotium", "binaries", "bash-rs");
  let versions: string[];
  try {
    versions = readdirSync(root).sort();
  } catch {
    return undefined;
  }
  for (const version of versions.reverse()) {
    const candidate = join(root, version, "bash-rs");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

// Route schema.ts / config.ts at an isolated temp DB. Must happen before any
// test file's static imports evaluate `#platform/config` — registered via
// `bunfig.toml` `[test].preload`.
const testRoot = mkdtempSync(join(tmpdir(), "negotium-test-"));
const codexHome = join(testRoot, ".codex");
const codexAuthFile = join(codexHome, "auth.json");
mkdirSync(codexHome, { recursive: true });
writeFileSync(codexAuthFile, "{}", "utf8");
process.env.NODE_ENV = "test";
// Synthetic rollouts must never inspect or mutate the developer's real
// ~/.codex tree during tests.
process.env.CODEX_HOME = codexHome;
process.env.NEGOTIUM_CODEX_AUTH_FILE = codexAuthFile;
delete process.env.DEFAULT_AGENT;
delete process.env.DEFAULT_MODEL;
delete process.env.FALLBACK_MODEL;
delete process.env.SESSION_MODEL;
delete process.env.GATEWAY_MODEL;
process.env.FALLBACK_AGENT = "codex";
process.env.SESSION_AGENT = "claude";
process.env.GATEWAY_AGENT = "claude";
process.env.SESSIONS_DB_PATH = join(testRoot, "test.db");
const bashRs = installedBashRs();
if (bashRs) process.env.NEGOTIUM_BASH_RS_BIN = bashRs;
process.env.NEGOTIUM_STATE_DIR = join(testRoot, "state");
process.env.NEGOTIUM_DATA_DIR = join(testRoot, "data");
process.env.NEGOTIUM_LOG_DIR = join(testRoot, "logs");
// Isolate `run/` so tests don't read/write the host's IPC queues.
process.env.NEGOTIUM_RUN_DIR = join(testRoot, "run");
process.env.NEGOTIUM_WORKSPACE_DIR = join(testRoot, "workspace");
process.env.NEGOTIUM_BROWSER_DIR = join(testRoot, "browser");
