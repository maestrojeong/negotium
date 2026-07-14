import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route @negotium/core state at an isolated temp tree. Must happen before any
// test file's static imports evaluate `#platform/config` — registered via
// `bunfig.toml` `[test].preload`.
const testRoot = mkdtempSync(join(tmpdir(), "negotium-otium-test-"));
process.env.NODE_ENV = "test";
delete process.env.DEFAULT_AGENT;
delete process.env.DEFAULT_MODEL;
delete process.env.FALLBACK_MODEL;
delete process.env.SESSION_MODEL;
delete process.env.GATEWAY_MODEL;
process.env.SESSIONS_DB_PATH = join(testRoot, "test.db");
process.env.NEGOTIUM_STATE_DIR = join(testRoot, "state");
process.env.NEGOTIUM_DATA_DIR = join(testRoot, "data");
process.env.NEGOTIUM_LOG_DIR = join(testRoot, "logs");
// Isolate `run/` so tests don't read/write the host's IPC queues.
process.env.NEGOTIUM_RUN_DIR = join(testRoot, "run");

// Never inherit a live join from the developer's shell.
delete process.env.OTIUM_CENTRAL_URL;
delete process.env.OTIUM_CELL_ID;
delete process.env.OTIUM_CELL_SECRET;

// Token-free guarantee: even if a test accidentally reaches a real provider
// path, no credentials are available.
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

export const TEST_ROOT = testRoot;
