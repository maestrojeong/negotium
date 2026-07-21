/**
 * Repo-root test preload. Bun only reads bunfig.toml from the cwd, so
 * package-level preloads do not run for `bun test` at the repo root — without
 * this, root runs would write topics/sessions into the real ~/.negotium.
 * Points all state at a throwaway dir BEFORE any package imports core, and
 * drops provider API keys so an accidentally-started agent turn cannot spend
 * tokens.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "negotium-root-test-"));
const codexHome = join(root, "codex");
const codexAuthFile = join(codexHome, "auth.json");
mkdirSync(codexHome, { recursive: true });
writeFileSync(codexAuthFile, "{}", "utf8");
process.env.NEGOTIUM_STATE_DIR = root;
process.env.NEGOTIUM_DATA_DIR = join(root, "data");
process.env.NEGOTIUM_LOG_DIR = join(root, "logs");
process.env.NEGOTIUM_RUN_DIR = join(root, "run");
process.env.SESSIONS_DB_PATH = join(root, "data", "sessions.db");
process.env.MAESTRO_DATA_DIR = join(root, "maestro");
process.env.CODEX_HOME = codexHome;
process.env.NEGOTIUM_CODEX_AUTH_FILE = codexAuthFile;

delete process.env.DEEPSEEK_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
