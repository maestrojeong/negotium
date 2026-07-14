import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Route @negotium/core state at an isolated temp tree. Must happen before any
// test file's static imports evaluate `#platform/config` — registered via
// `bunfig.toml` `[test].preload`.
const testRoot = mkdtempSync(join(tmpdir(), "negotium-adapter-telegram-test-"));
process.env.NODE_ENV = "test";
delete process.env.DEFAULT_AGENT;
delete process.env.DEFAULT_MODEL;
delete process.env.FALLBACK_MODEL;
delete process.env.SESSION_MODEL;
delete process.env.GATEWAY_MODEL;
// Guarantee no real agent/provider API is reachable: turns started by the
// adapter under test must fail fast instead of spending tokens.
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
// Deterministic voice-transcription state: core's default pipeline must look
// unconfigured regardless of the host shell's ffmpeg/whisper env.
delete process.env.FFMPEG_BIN;
delete process.env.FASTER_WHISPER_WRAPPER;
delete process.env.PYTHON_BIN;
delete process.env.WHISPER_MODEL_FILE;
process.env.SESSIONS_DB_PATH = join(testRoot, "test.db");
process.env.NEGOTIUM_STATE_DIR = join(testRoot, "state");
process.env.NEGOTIUM_DATA_DIR = join(testRoot, "data");
process.env.NEGOTIUM_LOG_DIR = join(testRoot, "logs");
// Isolate `run/` so tests don't read/write the host's IPC queues.
process.env.NEGOTIUM_RUN_DIR = join(testRoot, "run");
process.env.MAESTRO_DATA_DIR = join(testRoot, "maestro");

export const TEST_ROOT = testRoot;
