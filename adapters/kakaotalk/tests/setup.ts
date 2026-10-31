import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route @negotium/core state at an isolated temp tree. Must happen before any
// test file's static imports evaluate `#platform/config` — registered via
// `bunfig.toml` `[test].preload`. Copied from adapter-telegram's setup.
const testRoot = mkdtempSync(join(tmpdir(), "negotium-adapter-kakaotalk-test-"));
process.env.NODE_ENV = "test";
delete process.env.DEFAULT_AGENT;
delete process.env.DEFAULT_MODEL;
delete process.env.FALLBACK_MODEL;
delete process.env.SESSION_MODEL;
delete process.env.GATEWAY_MODEL;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MOONSHOT_API_KEY;
delete process.env.GLM_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
process.env.SESSIONS_DB_PATH = join(testRoot, "test.db");
process.env.NEGOTIUM_STATE_DIR = join(testRoot, "state");
process.env.NEGOTIUM_DATA_DIR = join(testRoot, "data");
process.env.NEGOTIUM_LOG_DIR = join(testRoot, "logs");
process.env.NEGOTIUM_RUN_DIR = join(testRoot, "run");
process.env.MAESTRO_DATA_DIR = join(testRoot, "maestro");

export const TEST_ROOT = testRoot;
