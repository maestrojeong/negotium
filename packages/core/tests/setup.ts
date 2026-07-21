import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
process.env.NEGOTIUM_STATE_DIR = join(testRoot, "state");
process.env.NEGOTIUM_DATA_DIR = join(testRoot, "data");
process.env.NEGOTIUM_LOG_DIR = join(testRoot, "logs");
// Isolate `run/` so tests don't read/write the host's IPC queues.
process.env.NEGOTIUM_RUN_DIR = join(testRoot, "run");
