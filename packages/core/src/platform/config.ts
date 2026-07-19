import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRuntimePort, readEnvText, safeRuntimePathSegment } from "#platform/config-helpers";
import { logger } from "#platform/logger";
import { type AgentKind, isAgentKind } from "#types";

export function envText(envKey: string): string | undefined {
  return readEnvText(process.env, envKey);
}

function resolveAgentEnv(envKey: string, fallback: AgentKind, legacyEnvKey?: string): AgentKind {
  const value = envText(envKey) ?? (legacyEnvKey ? envText(legacyEnvKey) : undefined);
  return isAgentKind(value) ? value : fallback;
}

const HOME = homedir();

// new URL("../..", import.meta.url) causes webpack to treat "../.." as a module import.
// Split into fileURLToPath → dirname → resolve to avoid that.
function resolveProjectRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packagedRuntime = resolve(moduleDir, "runtime");
  if (existsSync(resolve(packagedRuntime, "src"))) return packagedRuntime;
  return resolve(moduleDir, "../..");
}

export const PROJECT_ROOT = resolveProjectRoot();

/** Resolve a dependency executable from either a package-local or hoisted install. */
function resolveDependencyBin(name: string): string {
  let dir = PROJECT_ROOT;
  while (true) {
    const candidate = resolve(dir, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return candidate;
    dir = parent;
  }
}

// Each machine is one negotium node; all node state lives in one dotdir.
// NEGOTIUM_STATE_DIR overrides (useful for tests and multi-node-on-one-box).
const STATE_DIR_ENV = envText("NEGOTIUM_STATE_DIR");
export const STATE_DIR = STATE_DIR_ENV ? resolve(STATE_DIR_ENV) : resolve(HOME, ".negotium");

function resolveLocalStateDir(envKey: string, stateName: string): string {
  const envValue = envText(envKey);
  if (envValue) return resolve(envValue);
  return resolve(STATE_DIR, stateName);
}

function parsePortEnv(envValue: string | undefined, fallback: number): number {
  return parseRuntimePort(envValue, fallback);
}

export const WORKSPACE_DIR = resolveLocalStateDir("NEGOTIUM_WORKSPACE_DIR", "workspace");
export const TOPIC_WORKSPACE_DIR = resolve(WORKSPACE_DIR, "topics");
export const SHARED_WIKI_DIR = resolve(WORKSPACE_DIR, "wiki");
export const CONTEXTS_DIR = resolve(WORKSPACE_DIR, "contexts");
export const BROWSER_PROFILES_DIR = resolve(WORKSPACE_DIR, "browser-profiles");
export const DM_WORKSPACE_DIR = resolve(WORKSPACE_DIR, "dm");
export const SESSION_WORKSPACE_DIR = resolve(WORKSPACE_DIR, "sessions");
export const CLAUDE_EXECUTABLE = resolve(HOME, ".local/bin/claude");

// Browser automation uses the authenticated local Patchright HTTP wrapper.
export function resolveBrowserMcpBin(envValue?: string): string {
  const override = envValue?.trim();
  if (override) {
    if (!/(^|\/)(mcp-patchright|mcp-patchright-http\.mjs)$/.test(override)) {
      throw new Error(
        "NEGOTIUM_BROWSER_MCP_BIN must point to the authenticated mcp-patchright wrapper.",
      );
    }
    return override;
  }
  return PATCHRIGHT_MCP_BIN;
}

export const PATCHRIGHT_MCP_BIN = resolve(PROJECT_ROOT, "scripts/mcp-patchright-http.mjs");
export const PLAYWRIGHT_MCP_BIN = resolveBrowserMcpBin(envText("NEGOTIUM_BROWSER_MCP_BIN"));

// --- Browser egress proxy ---
//
// On a datacenter host (AWS) the browser's egress IP is a known cloud range,
// so anti-bot services (Cloudflare, DataDome, reCAPTCHA) challenge or block it
// far more than a residential IP would. Routing the automation browser through
// a residential/ISP proxy moves the egress IP out of the datacenter range.
//
// Operators set BROWSER_PROXY_URL, e.g. http://user:pass@proxy.host:8080 or
// socks5://proxy.host:1080. Credentials in the URL are split out because
// Playwright takes them as separate fields. BROWSER_PROXY_BYPASS is an optional
// comma-separated no-proxy list (e.g. "localhost,127.0.0.1,*.internal").
//
// NOTE: Chromium does not support authentication for SOCKS proxies — put
// credentials only on http/https proxy URLs.
export type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
};

export function resolveBrowserProxy(): BrowserProxyConfig | null {
  const raw = envText("BROWSER_PROXY_URL");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    logger.warn({ raw }, "Ignoring malformed BROWSER_PROXY_URL");
    return null;
  }
  // Playwright wants the server without embedded credentials.
  const server = `${url.protocol}//${url.host}`;
  const proxy: BrowserProxyConfig = { server };
  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);
  const bypass = envText("BROWSER_PROXY_BYPASS");
  if (bypass) proxy.bypass = bypass;
  return proxy;
}

// --- Node/tsx runtime for the `codex` agent's MCP servers ---
//
// codex 0.135's rmcp stdio MCP client cannot reliably complete the initialize
// handshake with servers spawned via `bun` (the JSON-RPC initialize is
// dropped/raced and no tools ever reach the model). Pure-node servers connect
// reliably, so codex turns launch the SAME .ts servers via node + tsx instead
// of `bun run`. claude/maestro keep using `bun run` (fast, native, unaffected).
//
// tsx transpiles .ts on the fly and resolves the `@/*` tsconfig path aliases,
// but only when it can find the tsconfig — and MCP servers run with cwd set to
// the user's workspace dir, not PROJECT_ROOT — so we pass TSX_TSCONFIG_PATH
// explicitly via env. Requires package.json `"type": "module"` so the servers'
// top-level `await` loads as ESM under node.
export const TSX_BIN = resolveDependencyBin("tsx");
export const TSCONFIG_PATH = resolve(PROJECT_ROOT, "tsconfig.json");

export const SESSION_COMM_SERVER = resolve(PROJECT_ROOT, "src/mcp/session-comm/server.ts");

export const TASK_SERVER = resolve(PROJECT_ROOT, "src/mcp/task-server.ts");
export const CANONICAL_MCP_PROXY_SERVER = resolve(
  PROJECT_ROOT,
  "src/mcp/canonical-proxy-server.ts",
);

export const WIKI_SERVER = resolve(PROJECT_ROOT, "src/mcp/wiki-server.ts");

export const TOKEN_STATS_SERVER = resolve(PROJECT_ROOT, "src/mcp/token-stats-server.ts");

export const SYSTEM_HEALTH_SERVER = resolve(PROJECT_ROOT, "src/mcp/system-health-server.ts");

export const AGENT_HEALTH_SERVER = resolve(PROJECT_ROOT, "src/mcp/agent-health-server.ts");

export const BACKGROUND_BASH_SERVER = resolve(PROJECT_ROOT, "src/mcp/background-bash-server.ts");

export const VAULT_SERVER = resolve(PROJECT_ROOT, "src/mcp/vault-server.ts");

export const BG_BASH_BASE_PORT = parsePortEnv(process.env.BG_BASH_BASE_PORT, 9700);
export const BG_BASH_MAX_PORT = parsePortEnv(process.env.BG_BASH_MAX_PORT, 9799);

function safeWorkspaceSegment(value: string, fallback: string): string {
  return safeRuntimePathSegment(value, fallback);
}

/** Resolve the shared filesystem workspace for an API topic. */
export function resolveTopicWorkspaceDir(topicId: string): string {
  return join(TOPIC_WORKSPACE_DIR, safeWorkspaceSegment(topicId, "topic"));
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

function loadOrCreateLocalSecret(
  envKey: string,
  filename: string,
  options: { persistEnvValue?: boolean } = {},
): string {
  const envValue = envText(envKey);
  const secretFile = resolve(STATE_DIR, filename);
  mkdirSync(dirname(secretFile), { recursive: true });
  if (envValue) {
    if (options.persistEnvValue) {
      writeFileSync(secretFile, `${envValue}\n`, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
    }
    return envValue;
  }

  if (existsSync(secretFile)) {
    const stored = readFileSync(secretFile, "utf-8").trim();
    if (stored) {
      chmodSync(secretFile, 0o600);
      return stored;
    }
  }

  const secret = randomBytes(32).toString("base64url");
  try {
    writeFileSync(secretFile, `${secret}\n`, { mode: 0o600, flag: "wx" });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stored = readFileSync(secretFile, "utf-8").trim();
    if (!stored) throw new Error(`Secret file exists but is empty: ${secretFile}`);
    chmodSync(secretFile, 0o600);
    return stored;
  }
}

export const RUNTIME_MCP_SECRET = loadOrCreateLocalSecret(
  "RUNTIME_MCP_SECRET",
  "runtime-mcp-secret",
);
/** Local bearer token for the loopback node-control API. */
export const NODE_CONTROL_TOKEN = loadOrCreateLocalSecret(
  "NEGOTIUM_CONTROL_TOKEN",
  "node-control-token",
);
export const VAULT_MASTER_KEY = loadOrCreateLocalSecret(
  "NEGOTIUM_VAULT_MASTER_KEY",
  "vault-master-key",
  { persistEnvValue: true },
);
// Agent/tool subprocesses inherit process.env. Keep the loaded key in this
// process only so `env`/`ps` inside an agent workspace cannot reveal it.
delete process.env.NEGOTIUM_VAULT_MASTER_KEY;

/** The node's single open port: runtime MCP endpoint + node API. */
export const NEGOTIUM_PORT = parseInt(process.env.NEGOTIUM_PORT || "7777", 10);
export const hostname = process.env.HOSTNAME || "127.0.0.1";

// Persistent state (survives restarts, long-lived)
export const DATA_DIR = resolveLocalStateDir("NEGOTIUM_DATA_DIR", "data");
export const LOG_DIR = resolveLocalStateDir("NEGOTIUM_LOG_DIR", "logs");
// SESSIONS_DB_PATH env override lets tests point the DB singleton at a temp file.
export const SESSIONS_DB = process.env.SESSIONS_DB_PATH
  ? resolve(process.env.SESSIONS_DB_PATH)
  : resolve(DATA_DIR, "sessions.db");
export const DEBUG_FILE = resolve(DATA_DIR, "debug-users.json");
export const USERS_LOG_DIR = resolve(DATA_DIR, "users");

// Runtime IPC queues (transient, safe to clear on restart)
export const RUN_DIR = resolveLocalStateDir("NEGOTIUM_RUN_DIR", "run");
export const PROGRESS_DIR = resolve(RUN_DIR, "progress");
export const DM_CMD_DIR = resolve(RUN_DIR, "dm-commands");
export const DM_RESP_DIR = resolve(RUN_DIR, "dm-responses");
export const SESSION_INBOX_DIR = resolve(RUN_DIR, "session-inbox");
export const SESSION_ASKS_DIR = resolve(RUN_DIR, "session-asks");
export const PLAYWRIGHT_BASE_PORT = parsePortEnv(process.env.PLAYWRIGHT_BASE_PORT, 9100);
export const PLAYWRIGHT_MAX_PORT = parsePortEnv(process.env.PLAYWRIGHT_MAX_PORT, 9499);
export const PLAYWRIGHT_PORTS_DIR = resolve(RUN_DIR, "playwright-ports");
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(PROGRESS_DIR, { recursive: true });
mkdirSync(DM_CMD_DIR, { recursive: true });
mkdirSync(DM_RESP_DIR, { recursive: true });
mkdirSync(SESSION_INBOX_DIR, { recursive: true });
mkdirSync(SESSION_ASKS_DIR, { recursive: true });
mkdirSync(PLAYWRIGHT_PORTS_DIR, { recursive: true });
mkdirSync(WORKSPACE_DIR, { recursive: true });
mkdirSync(TOPIC_WORKSPACE_DIR, { recursive: true });
mkdirSync(SHARED_WIKI_DIR, { recursive: true });
mkdirSync(CONTEXTS_DIR, { recursive: true });
mkdirSync(BROWSER_PROFILES_DIR, { recursive: true });
mkdirSync(DM_WORKSPACE_DIR, { recursive: true });
mkdirSync(SESSION_WORKSPACE_DIR, { recursive: true });

/** Stale threshold for active-query state files (crash recovery) */
export const ACTIVE_QUERY_STALE_MS = 10 * 60 * 1000; // 10 minutes

export const AGENTS_PROMPTS_DIR = resolve(PROJECT_ROOT, "src/prompts/agents");
export const RESOURCES_DIR = resolve(PROJECT_ROOT, "src/resources");

/** Returns process.env without CLAUDECODE, to prevent nested claude-code detection in subprocesses. */
export function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

export const FILE_EXTENSIONS_REGEX =
  /(?:\/[^\s"'<>|*?[\]]+\.(?:png|jpg|jpeg|gif|webp|svg|pdf|csv|xlsx|xls|json|txt|md|html|zip|py|js|ts|tsx|jsx|css|xml|yaml|yml|docx|pptx))/gi;

export const FILE_TAG_REGEX = /\[FILE:(\/[^\]]+)\]/gi;

// Canonical Claude model IDs — update here when Anthropic releases new versions
export const MODEL_SONNET = "claude-sonnet-5";
export const MODEL_OPUS = "claude-opus-4-8";
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";
export const MODEL_FABLE = "claude-fable-5"; // Mythos-class, announced 2026-06-09

// DeepSeek V4 (released 2026-04-24). API is OpenAI-compatible at
// https://api.deepseek.com/v1/chat/completions; thinking mode is enabled via
// `extra_body.thinking.type` + `reasoning_effort`. Legacy `deepseek-chat` /
// `deepseek-reasoner` are deprecated 2026-07-24.
export const MODEL_DEEPSEEK_V4_PRO = "deepseek-v4-pro";
export const MODEL_DEEPSEEK_V4_FLASH = "deepseek-v4-flash";

// Agent + model defaults split by session role. FALLBACK_* is the shared base;
// SESSION_* overrides topic + ephemeral; GATEWAY_* overrides dm + manager.
// DEFAULT_* is accepted as a legacy alias during the env migration window.
export const FALLBACK_AGENT: AgentKind = resolveAgentEnv(
  "FALLBACK_AGENT",
  "maestro",
  "DEFAULT_AGENT",
);
export const SESSION_AGENT: AgentKind = resolveAgentEnv("SESSION_AGENT", FALLBACK_AGENT);
export const GATEWAY_AGENT: AgentKind = resolveAgentEnv("GATEWAY_AGENT", FALLBACK_AGENT);

export const FALLBACK_MODEL = envText("FALLBACK_MODEL") ?? envText("DEFAULT_MODEL");

function resolveModelEnv(envKey: string, agentConst: AgentKind): string | undefined {
  return envText(envKey) ?? (agentConst === FALLBACK_AGENT ? FALLBACK_MODEL : undefined);
}

export const SESSION_MODEL = resolveModelEnv("SESSION_MODEL", SESSION_AGENT);
export const GATEWAY_MODEL = resolveModelEnv("GATEWAY_MODEL", GATEWAY_AGENT);

/** Resolve the effective display/default model for a topic (session context).
 *  Applies the session model override only when that role owns the agent;
 *  otherwise each registry's native default stays authoritative. */
export function resolveDefaultModel(agent: string, registryDefaultModel: string): string {
  return agent === SESSION_AGENT && SESSION_MODEL ? SESSION_MODEL : registryDefaultModel;
}

// ── External tool binaries + media pipeline env ───────────────────
// (src/media/* 에서 사용. 미설정 시 fallback 의미는 기존 그대로:
//  FFMPEG_BIN은 text-extractor에서 필수(undefined면 spawn 시점 실패),
//  video.ts에서는 PATH의 ffmpeg/ffprobe로 fallback.)
export const FFMPEG_BIN = envText("FFMPEG_BIN");
export const FFPROBE_BIN = envText("FFPROBE_BIN");
export const PYTHON_BIN = envText("PYTHON_BIN") ?? "python3";
export const FASTER_WHISPER_WRAPPER =
  envText("FASTER_WHISPER_WRAPPER") ?? resolve(PROJECT_ROOT, "scripts/faster-whisper-wrapper.py");
export const WHISPER_MODEL = envText("WHISPER_MODEL_FILE") ?? "turbo";
export const TESSERACT_BIN = envText("TESSERACT_BIN") ?? "tesseract";
export const PDFTOTEXT_BIN = envText("PDFTOTEXT_BIN") ?? "pdftotext";

// Max tell_session relay depth from origin user. ask_session forks reset to
// depth=0, so this only caps tell_session chains. Override via MAX_TELL_DEPTH
// (positive int); defaults to 20 when unset or invalid.
const _envMaxTellDepth = Number.parseInt(process.env.MAX_TELL_DEPTH ?? "", 10);
export const MAX_TELL_DEPTH =
  Number.isInteger(_envMaxTellDepth) && _envMaxTellDepth > 0 ? _envMaxTellDepth : 20;

/** Codex CLI auth file. 호출 시점에 env를 읽는다 — 테스트가 런타임에
 *  NEGOTIUM_CODEX_AUTH_FILE을 바꾸므로 모듈 로드 상수로 만들면 안 된다. */
export function codexAuthFilePath(): string {
  return process.env.NEGOTIUM_CODEX_AUTH_FILE || join(homedir(), ".codex", "auth.json");
}

// System defaults moved to per-agent registries
// (`src/agents/{claude,codex}-registry.ts`). Read via
// `getRegistry(agent).defaultModel` / `.defaultEffort`.

// MCP server builders -> src/platform/mcp-config.ts
