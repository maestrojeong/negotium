import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  FileChangeItem,
  McpToolCallItem,
  ModelReasoningEffort,
  SandboxMode,
  ThreadOptions,
} from "@openai/codex-sdk";
import { Codex } from "@openai/codex-sdk";
import {
  ensureCodexModelCache,
  writeCodexCatalogWithNativeMultiAgentDisabled,
} from "#agents/codex-native-multi-agent";
import {
  acquireCodexSpawnLock,
  findNewCodexChildren,
  killCodexTrees,
  registerOwnedCodexPids,
  snapshotCodexChildren,
  unregisterOwnedCodexPids,
} from "#agents/codex-tree-kill";
import { hostedCodexAuthFilePath, hostedMcpServers } from "#agents/execution-host";
import {
  migrateCodexRolloutNativeMultiAgentMetadata,
  readCodexPatchCallIds,
  readLatestCodexContextUsage,
  readLatestCodexPatchPreview,
} from "#agents/rollout/codex";
import { buildNumberedDiffSummary } from "#agents/tool-format";
import { extractFileEvents } from "#media/file-events";
import { errMsg } from "#platform/error";
import { logger } from "#platform/logger";
import {
  browserOwnerCapability,
  browserOwnerForContext,
  CODEX_BROWSER_CAPABILITY_ENV,
} from "#platform/mcp-config";
import type { AgentQueryOptions, EffortLevel, UnifiedEvent } from "#types";

/**
 * Pass Otium's EffortLevel through to Codex's ModelReasoningEffort.
 *
 * Storage validation (`getRegistry("codex").validateEffort` in the repository
 * setters) guarantees that any effort persisted on a codex topic is one of
 * codex's accepted set (`low | medium | high | xhigh`), so the SDK shape and
 * the stored shape are identical for codex topics. A `max` or `minimal`
 * reaching this function means storage validation was bypassed — we throw
 * instead of silently demoting so the bug surfaces rather than masking itself.
 */
function mapEffort(effort?: EffortLevel): ModelReasoningEffort | undefined {
  if (!effort) return undefined;
  if (effort === "max" || (effort as string) === "minimal") {
    throw new Error(
      `codexProvider received effort='${effort}', which codex does not support — storage validation was bypassed`,
    );
  }
  return effort as ModelReasoningEffort;
}

/**
 * Convert Otium's mcp-config output (Claude SDK shape) to Codex's
 * `config.mcp_servers` shape. Codex supports two transports:
 *   - stdio: `{ command, args?, env? }`
 *   - streamable HTTP: `{ url }` (verified via `codex mcp add --url`)
 *
 * Entries with the SSE transport shape (`{ type: "sse", url }`) are dropped:
 * codex doesn't speak SSE. Callers must produce the streamable HTTP shape
 * for codex by passing `agent: "codex"` into the `playwright.build()` arm
 * in `mcp-config.ts` (which switches `/sse` → `/mcp`).
 */
type CodexMcpTimeouts = {
  enabled?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
};
type CodexStdioServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
} & CodexMcpTimeouts;
type CodexHttpServer = {
  url: string;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
} & CodexMcpTimeouts;
type CodexMcpServer = CodexStdioServer | CodexHttpServer;

const CODEX_MCP_SERVER_NAME_OVERRIDES: Record<string, string> = {
  // Codex merges per-turn `--config mcp_servers.<name>.*` overrides with the
  // user's global ~/.codex/config.toml. `playwright` is a common global stdio
  // server name, and adding Otium's per-topic HTTP `url` to that same table
  // makes Codex fail config parsing with "url is not supported for stdio".
  playwright: "otium_playwright",
};

function codexMcpServerName(name: string): string {
  return CODEX_MCP_SERVER_NAME_OVERRIDES[name] ?? name;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function withCodexMcpServerOverrides(_name: string, server: CodexMcpServer): CodexMcpServer {
  // For codex, Otium launches MCP servers via node + tsx (see serverLaunch in
  // mcp-config.ts), which transpiles the .ts on the fly — cold start is slower
  // than `bun run`, so give the handshake a generous startup window. codex's
  // default startup timeout is short enough that a heavier server can miss it.
  return {
    startup_timeout_sec: parsePositiveInt(process.env.CODEX_MCP_STARTUP_TIMEOUT_SEC, 30),
    ...server,
  };
}

export function toCodexMcpServers(
  claudeShape: Record<string, unknown>,
): Record<string, CodexMcpServer> {
  // Codex merges turn config with ~/.codex/config.toml instead of replacing it.
  // Disable common global browser stdio servers so browser state can only flow
  // through Negotium's long-lived, owner-scoped HTTP server.
  const disabledBrowserStdio = (): CodexStdioServer => ({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    enabled: false,
  });
  const out: Record<string, CodexMcpServer> = {
    playwright: disabledBrowserStdio(),
    "browser-rs": disabledBrowserStdio(),
    patchright: disabledBrowserStdio(),
  };
  for (const [name, srv] of Object.entries(claudeShape)) {
    if (!srv || typeof srv !== "object") continue;
    const s = srv as Record<string, unknown>;
    const codexName = codexMcpServerName(name);
    if (typeof s.command === "string") {
      out[codexName] = withCodexMcpServerOverrides(name, {
        command: s.command,
        ...(Array.isArray(s.args) ? { args: s.args as string[] } : {}),
        ...(s.env && typeof s.env === "object" ? { env: s.env as Record<string, string> } : {}),
      });
      continue;
    }
    if (typeof s.url === "string" && s.type !== "sse") {
      out[codexName] = withCodexMcpServerOverrides(name, {
        url: s.url,
        ...(s.http_headers && typeof s.http_headers === "object"
          ? { http_headers: s.http_headers as Record<string, string> }
          : {}),
        ...(s.env_http_headers && typeof s.env_http_headers === "object"
          ? { env_http_headers: s.env_http_headers as Record<string, string> }
          : {}),
      });
    }
  }
  return out;
}

function isMissingCodexRolloutError(err: unknown): boolean {
  const msg = errMsg(err);
  return /no rollout found|thread\/resume failed/i.test(msg);
}

/**
 * Render an `mcp_tool_call` item's terminal payload into a short string for
 * the unified `tool_result` event. The SDK shape is
 *   `result?: { content: ContentBlock[]; structured_content: unknown }` on
 *   success, or `error?: { message: string }` on failure — neither is a raw
 * string, which is why the previous `typeof result === "string"` branch was
 * unreachable. Truncate to 200 chars to match command_execution behavior.
 */
function summarizeMcpToolCallResult(item: McpToolCallItem): string {
  if (item.error) return item.error.message.slice(0, 200);
  if (!item.result) return "";
  const blocks = Array.isArray(item.result.content) ? item.result.content : [];
  const text = blocks
    .map((b) => {
      if (b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b) {
        return String((b as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  if (text) return text.slice(0, 200);
  // Fall back to a JSON dump of structured_content for non-text content blocks.
  return JSON.stringify(item.result.structured_content ?? "").slice(0, 200);
}

const CODEX_DIFF_FILE_LIMIT = 512 * 1024;
const CODEX_DIFF_BASELINE_FILE_LIMIT = 200;
const CODEX_DIFF_BASELINE_BYTE_LIMIT = 16 * 1024 * 1024;

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function textFile(path: string, maxBytes = CODEX_DIFF_FILE_LIMIT): string | null | undefined {
  if (!existsSync(path)) return null;
  try {
    const byteLimit = Math.min(CODEX_DIFF_FILE_LIMIT, Math.max(0, maxBytes));
    if (statSync(path).size > byteLimit) return undefined;
    const content = readFileSync(path);
    if (content.byteLength > byteLimit || content.includes(0)) return undefined;
    return content.toString("utf8");
  } catch {
    return undefined;
  }
}

interface CodexFilePreview {
  before?: string;
  after?: string;
  diff_preview?: string;
}

/**
 * Codex's SDK exposes only path + change kind, not the patch body. Capture the
 * dirty worktree at turn start and compare each completed file_change against
 * that moving baseline. This preserves user edits that already existed before
 * the turn and gives repeated edits to the same file their own +/- preview.
 */
class CodexFilePreviewTracker {
  readonly #cwd: string;
  readonly #root: string | null;
  readonly #baseline = new Map<string, string | null | undefined>();
  #baselineAvailable = false;

  constructor(cwd: string) {
    this.#cwd = canonicalPath(cwd);
    const root = this.#git(["rev-parse", "--show-toplevel"], this.#cwd)?.trim();
    this.#root = root ? canonicalPath(root) : null;
    if (!this.#root) return;
    const status = this.#git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status === undefined) return;
    this.#baselineAvailable = true;
    let loadedFiles = 0;
    let loadedBytes = 0;
    const records = status.split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4) continue;
      const code = record.slice(0, 2);
      const path = record.slice(3);
      const remainingBytes = CODEX_DIFF_BASELINE_BYTE_LIMIT - loadedBytes;
      const content =
        loadedFiles < CODEX_DIFF_BASELINE_FILE_LIMIT && remainingBytes > 0
          ? textFile(resolve(this.#root, path), remainingBytes)
          : undefined;
      this.#baseline.set(path, content);
      if (typeof content === "string") {
        loadedFiles += 1;
        loadedBytes += Buffer.byteLength(content);
      }
      if (/[RC]/.test(code)) index += 1;
    }
  }

  preview(path: string, succeeded: boolean): CodexFilePreview {
    if (!this.#root || !this.#baselineAvailable || !succeeded) return {};
    const absolute = canonicalPath(isAbsolute(path) ? path : resolve(this.#cwd, path));
    const relativePath = relative(this.#root, absolute);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return {};

    const before = this.#baseline.has(relativePath)
      ? this.#baseline.get(relativePath)
      : this.#headFile(relativePath);
    const after = textFile(absolute);
    this.#baseline.set(relativePath, after);
    if (before === undefined || after === undefined) return {};

    const diff = buildNumberedDiffSummary(before ?? "", after ?? "");
    return {
      ...(diff.before !== undefined ? { before: diff.before } : {}),
      ...(diff.after !== undefined ? { after: diff.after } : {}),
      ...(diff.diffPreview !== undefined ? { diff_preview: diff.diffPreview } : {}),
    };
  }

  #headFile(path: string): string | null | undefined {
    const content = this.#git(["show", `HEAD:${path}`]);
    if (content === undefined) return null;
    return Buffer.byteLength(content) > CODEX_DIFF_FILE_LIMIT || content.includes("\0")
      ? undefined
      : content;
  }

  #git(args: string[], cwd = this.#root ?? undefined): string | undefined {
    try {
      return execFileSync("git", ["-C", cwd ?? ".", ...args], {
        encoding: "utf8",
        maxBuffer: CODEX_DIFF_FILE_LIMIT * 4,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
  }
}

// Codex emits file_change only after the patch finishes, so surface the
// completed changes immediately as paired tool_use/tool_result events.
async function fileChangeEvents(
  item: FileChangeItem,
  previews: CodexFilePreviewTracker,
  cwd: string,
  threadId: string | null | undefined,
  consumedPatchCallIds: Set<string>,
): Promise<UnifiedEvent[]> {
  const expectedPaths = item.changes.map((change) =>
    isAbsolute(change.path) ? change.path : resolve(cwd, change.path),
  );
  let nativePreview: ReturnType<typeof readLatestCodexPatchPreview>;
  // The SDK can emit item.completed a few milliseconds before Codex flushes
  // patch_apply_end to its rollout. Give that write a brief head start before
  // the first lookup, which also avoids matching an older patch for the same
  // path on resumed threads.
  if (threadId && item.status === "completed") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    nativePreview = readLatestCodexPatchPreview(threadId, expectedPaths, consumedPatchCallIds);
  }
  for (const delayMs of [20, 40, 80, 120]) {
    if (nativePreview || !threadId || item.status !== "completed") break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    nativePreview = readLatestCodexPatchPreview(threadId, expectedPaths, consumedPatchCallIds);
  }
  if (nativePreview) consumedPatchCallIds.add(nativePreview.callId);

  return item.changes.flatMap((change, index) => {
    const name = change.kind === "add" ? "Write" : change.kind === "delete" ? "Delete" : "Edit";
    const toolUseId = `${item.id}:${index}`;
    const success = item.status === "completed";
    const nativeChange = nativePreview?.changes[index];
    // Keep the moving filesystem baseline current even when the native patch
    // supplies the display preview. A later edit to the same file may need the
    // filesystem fallback, which must compare against this edit—not turn start.
    const fallbackPreview = previews.preview(change.path, success);
    const preview =
      success && nativeChange
        ? {
            ...(nativeChange.before !== undefined ? { before: nativeChange.before } : {}),
            ...(nativeChange.after !== undefined ? { after: nativeChange.after } : {}),
            ...(nativeChange.diffPreview !== undefined
              ? { diff_preview: nativeChange.diffPreview }
              : {}),
          }
        : fallbackPreview;
    return [
      {
        type: "tool_use" as const,
        name,
        input: { file_path: change.path, change_kind: change.kind, ...preview },
        toolUseId,
      },
      {
        type: "tool_result" as const,
        toolUseId,
        content: success
          ? `${change.kind} applied: ${change.path}`
          : `${change.kind} failed: ${change.path}`,
        // Explicit failure flag so clients don't have to parse the content
        // string to tell a failed file change from an applied one.
        ...(success ? {} : { isError: true as const }),
      },
    ];
  });
}

function promptForThread(opts: AgentQueryOptions, includeSystemPrompt: boolean): string {
  return includeSystemPrompt && opts.systemPrompt
    ? `[System Instructions]\n${opts.systemPrompt}\n\n${opts.prompt}`
    : opts.prompt;
}

/**
 * Start a streamed turn and identify the codex PIDs we spawned, holding the
 * global spawn lock across the full window from baseline → first event.
 *
 * Why hold the lock across iteration: `@openai/codex-sdk`'s `runStreamed()`
 * returns a lazy async generator object. The actual `child_process.spawn()`
 * call happens on the first `iterator.next()`, not when `runStreamed()` is
 * awaited (see `node_modules/@openai/codex-sdk/dist/index.js:51-93,238`).
 * If we released the lock after `await runStreamed(...)`, a concurrent
 * codex caller's baseline would race against our actual spawn and one
 * caller would mis-attribute the other's PID.
 *
 * Returns the iterator (positioned just past the first event) plus the
 * first event itself, so the streaming loop can re-emit it before
 * resuming `iterator.next()`.
 */
type StartResult = {
  iter: AsyncIterator<unknown>;
  firstEvent: unknown;
  done: boolean;
};

async function closeIterator(iter: AsyncIterator<unknown>): Promise<void> {
  try {
    await iter.return?.();
  } catch (err) {
    logger.warn({ err }, "codexProvider: failed to close codex event iterator");
  }
}

/**
 * Bound the spawn→first-event window. `thread.started` normally arrives within
 * a few seconds, so if NOTHING comes back in this window the codex turn is
 * genuinely stuck at startup (the bare-`/codex` hang symptom). We surface a
 * clear error fast instead of waiting out the much longer mid-stream heartbeat
 * (8 min) — a stuck startup never recovers, and retrying it is futile. Once the
 * first event arrives, the normal heartbeat governs long-running work.
 */
const CODEX_STARTUP_TIMEOUT_MS = 90_000;

async function startStreamedWithTracking(
  thread: ReturnType<Codex["startThread"]>,
  prompt: string,
  abortSignal: AbortSignal | undefined,
  trackedPids: { pids: number[] },
): Promise<StartResult> {
  const release = await acquireCodexSpawnLock();
  try {
    const baseline = snapshotCodexChildren();
    const runResult = await thread.runStreamed(prompt, {
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    const iter = (runResult.events as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    // Force the first iterator step — this is when the SDK actually
    // child_process.spawn()s codex. After this awaits, the codex PID is
    // visible to pgrep as a child of our process.
    let first: IteratorResult<unknown>;
    // Startup watchdog: race the first event against CODEX_STARTUP_TIMEOUT_MS so
    // a codex that spawns but never emits anything can't hang the turn. On
    // timeout the iter.next() promise loses the race and we fall into the catch
    // below, which kills the spawned tree, closes the iterator, and rethrows the
    // clear error — surfaced to the user as an `error` event (no infinite wait).
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startupTimeout = new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () =>
            reject(
              new Error(
                `Codex가 ${CODEX_STARTUP_TIMEOUT_MS / 1000}초 내 응답을 시작하지 않아 중단했습니다. 다시 시도해주세요.`,
              ),
            ),
          CODEX_STARTUP_TIMEOUT_MS,
        );
      });
      // Swallow a late rejection from the losing promise: if the startup
      // timeout wins the race, this dangling next() may settle later with
      // nobody awaiting it (would surface as an unhandledRejection).
      const nextP = iter.next();
      nextP.catch(() => {});
      first = await Promise.race([nextP, startupTimeout]);
    } catch (err) {
      // Abort OR startup-timeout after the SDK spawned codex but before the
      // first event resolves: the normal abort listener still sees no tracked
      // PID, so diff the baseline here and kill anything attributable before
      // propagating.
      const novel = findNewCodexChildren(baseline);
      if (novel.length > 0) {
        killCodexTrees(novel);
      }
      await closeIterator(iter);
      throw err;
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
    const novel = findNewCodexChildren(baseline);
    trackedPids.pids = novel;
    registerOwnedCodexPids(novel);
    return { iter, firstEvent: first.value, done: !!first.done };
  } finally {
    release();
  }
}

/**
 * Wrap an iterator into an AsyncIterable that first yields a pre-captured
 * `firstEvent` and then drains the underlying iterator. Lets the streaming
 * `for await` loop keep its existing switch over events without special-casing
 * the first iteration we already consumed during PID tracking.
 */
function prependFirstEvent(
  iter: AsyncIterator<unknown>,
  firstEvent: unknown,
  alreadyDone: boolean,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let emittedFirst = false;
      let exhausted = alreadyDone;
      return {
        async next(): Promise<IteratorResult<unknown>> {
          if (!emittedFirst) {
            emittedFirst = true;
            if (alreadyDone) return { value: undefined, done: true };
            return { value: firstEvent, done: false };
          }
          if (exhausted) return { value: undefined, done: true };
          const r = await iter.next();
          if (r.done) exhausted = true;
          return r;
        },
        async return(value?: unknown): Promise<IteratorResult<unknown>> {
          exhausted = true;
          if (iter.return) return iter.return(value);
          return { value, done: true };
        },
      };
    },
  };
}

/**
 * Core Codex provider.
 * Same UnifiedEvent contract as claudeProvider. Uses @openai/codex-sdk.
 *
 * Notes:
 *   - Codex has no `systemPrompt` option; prepend the current topic/system
 *     instructions on every invocation, including resumed synthetic threads.
 *   - Per-turn MCP isolation is achieved via CodexOptions.config.mcp_servers,
 *     so the global ~/.codex/config.toml stays untouched.
 *   - Streaming token-by-token text deltas are not exposed by the SDK; only
 *     final agent_message and per-item updates. Callers that rely on
 *     text_delta should still work because we yield a single text/result
 *     event when the assistant message completes.
 */
export async function* codexProvider(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  const filePreviews = new CodexFilePreviewTracker(opts.cwd);
  // A resumed rollout may already contain patches for the same file. Mark
  // those calls consumed before this turn starts so a delayed new flush can
  // never be mistaken for the previous turn's edit.
  const consumedPatchCallIds = new Set(opts.sessionId ? readCodexPatchCallIds(opts.sessionId) : []);
  // Up-front auth file check — gives the user an actionable message
  // ("`codex login` 으로 다시 로그인해주세요") immediately instead of waiting
  // for the @openai/codex-sdk to spawn the codex binary and surface an
  // opaque OAuth failure on the first turn. Path is the default codex
  // location unless NEGOTIUM_CODEX_AUTH_FILE relocates it for this host.
  const codexAuthPath = hostedCodexAuthFilePath();
  if (!existsSync(codexAuthPath)) {
    yield {
      type: "error",
      content: `Codex auth file not found at ${codexAuthPath}. Run \`codex login\` to authenticate.`,
    };
    return;
  }

  let codexModelCatalogPath: string;
  try {
    const codexModelCachePath = await ensureCodexModelCache(codexAuthPath);
    codexModelCatalogPath = writeCodexCatalogWithNativeMultiAgentDisabled(
      codexAuthPath,
      codexModelCachePath,
    );
    if (opts.sessionId) migrateCodexRolloutNativeMultiAgentMetadata(opts.sessionId);
  } catch (err) {
    yield {
      type: "error",
      content: `Failed to enforce the Codex native multi-agent policy: ${errMsg(err)}`,
    };
    return;
  }

  const codexMcpServers = toCodexMcpServers(hostedMcpServers(opts));
  const browserOwner = browserOwnerForContext(opts);
  const scopedBrowserCapability =
    opts.playwrightCapability && browserOwner
      ? browserOwnerCapability(opts.playwrightCapability, browserOwner)
      : undefined;

  // Startup trace: codexProvider was otherwise silent until its first error or
  // heartbeat (8 min), so a stuck turn left "0 lines of codex" in the logs and
  // was impossible to localize (bug B). Record the resolved model/effort/cwd +
  // whether this is a fresh thread or a resume, so a future hang is pinpointed
  // to setup vs. the first stream step.
  logger.info(
    {
      model: opts.model ?? "(sdk default)",
      effort: opts.effort ?? "(off)",
      cwd: opts.cwd,
      cwdExists: existsSync(opts.cwd),
      resume: Boolean(opts.sessionId),
      mcpServerCount: Object.keys(codexMcpServers).length,
    },
    "codexProvider: starting turn",
  );

  const codex = new Codex({
    ...(scopedBrowserCapability
      ? {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
            [CODEX_BROWSER_CAPABILITY_ENV]: scopedBrowserCapability,
          },
        }
      : {}),
    config: {
      // Otium exposes delegation through runtime.spawn_subagent so child work
      // gets its own room/card and its result is routed back to the parent.
      // Codex enables its provider-native collaboration tools from the user's
      // global config by default; explicitly turn that feature off so tools
      // such as spawn_agent/send_message cannot bypass Otium's orchestration
      // and so subagent rooms cannot recursively fan out through Codex.
      // Codex model metadata can override these flags. The authoritative
      // catalog above sets multi_agent_version=disabled as the hard stop; keep
      // all feature switches off as a second layer and for future CLI versions.
      features: { multi_agent: false, multi_agent_v2: false, enable_fanout: false },
      model_catalog_json: codexModelCatalogPath,
      mcp_servers: codexMcpServers,
    },
  });

  const threadOptions: ThreadOptions = {
    workingDirectory: opts.cwd,
    skipGitRepoCheck: true,
    // Codex sandbox is intentionally disabled: Otium already assigns a managed
    // workspace cwd for the turn, and the bot is expected to act on it freely on
    // the user's behalf. SDK-level sandboxing would only constrain reach inside
    // that already-owned directory, which is not the threat model.
    sandboxMode: "danger-full-access" as SandboxMode,
    approvalPolicy: "never",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { modelReasoningEffort: mapEffort(opts.effort) } : {}),
  };

  let currentSessionId = opts.sessionId;

  // Codex SDK has no systemPrompt option. A resumed thread may have been
  // synthesized from a captured shell, so always refresh the current runtime
  // instructions instead of trusting historical developer/environment data.
  let thread = currentSessionId
    ? codex.resumeThread(currentSessionId, threadOptions)
    : codex.startThread(threadOptions);
  let prompt = promptForThread(opts, true);

  let agentTextSoFar = "";
  let currentAgentMessageId: string | undefined;
  let finalText = "";
  let stopReason = "end_turn";

  // Tree-kill instrumentation. The codex SDK spawns the `codex` binary as a
  // direct child of our process but does not expose the PID or place it in
  // its own process group. We identify our PIDs by diffing pgrep snapshots
  // around the SDK's first iterator step (when codex is actually spawned),
  // and SIGTERM the whole tree on abort with SIGKILL fallback inside
  // killCodexTrees().
  const trackedPids: { pids: number[] } = { pids: [] };
  const abortSignal = opts.abortController?.signal;
  const onAbortKill = () => {
    if (trackedPids.pids.length > 0) {
      killCodexTrees(trackedPids.pids);
    }
  };
  abortSignal?.addEventListener("abort", onAbortKill, { once: true });

  // Heartbeat: if the Codex API emits no events within the window, abort the
  // current stream and resume the thread with a short continuation prompt.
  // The interval doubles each attempt (up to HEARTBEAT_MAX_MS) to avoid
  // interrupting genuinely long-running work on the first timeout.
  let heartbeatMs = 8 * 60 * 1000;
  let heartbeatAttempts = 0;
  const HEARTBEAT_MAX_MS = 16 * 60 * 1000;
  const HEARTBEAT_MAX_ATTEMPTS = 2;
  const HEARTBEAT_CONTINUATION = "계속 진행해줘.";

  try {
    while (true) {
      if (abortSignal?.aborted) return;

      // Per-attempt abort controller: lets the heartbeat timer abort only
      // this attempt's stream without touching the user-facing outer signal.
      const attemptAbort = new AbortController();
      const propagateOuter = () => attemptAbort.abort();
      abortSignal?.addEventListener("abort", propagateOuter, { once: true });

      trackedPids.pids = [];
      let heartbeatTriggered = false;
      let attemptCompleted = false;
      let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

      const scheduleHeartbeat = () => {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
        if (abortSignal?.aborted || attemptAbort.signal.aborted) return;
        heartbeatTimer = setTimeout(() => {
          heartbeatTriggered = true;
          if (trackedPids.pids.length > 0) killCodexTrees(trackedPids.pids);
          attemptAbort.abort();
        }, heartbeatMs);
      };

      try {
        scheduleHeartbeat();

        let startResult!: StartResult;
        try {
          startResult = await startStreamedWithTracking(
            thread,
            prompt,
            attemptAbort.signal,
            trackedPids,
          );
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") throw err;
          if (!currentSessionId || !isMissingCodexRolloutError(err)) throw err;
          logger.warn(
            { staleSessionId: currentSessionId, err: errMsg(err) },
            "codexProvider: stale/missing rollout, restarting fresh thread",
          );
          thread = codex.startThread(threadOptions);
          prompt = promptForThread(opts, true);
          currentSessionId = undefined;
          startResult = await startStreamedWithTracking(
            thread,
            prompt,
            attemptAbort.signal,
            trackedPids,
          );
        }

        // Cover the narrow window where abort fired between PID registration
        // and the abort listener actually running.
        if (attemptAbort.signal.aborted) {
          killCodexTrees(trackedPids.pids);
          await closeIterator(startResult.iter);
          throw Object.assign(new Error("heartbeat abort"), { name: "AbortError" });
        }

        const eventStream = prependFirstEvent(
          startResult.iter,
          startResult.firstEvent,
          startResult.done,
        );

        for await (const rawEvent of eventStream) {
          scheduleHeartbeat();

          const event = rawEvent as {
            type: string;
            thread_id?: string;
            item?: {
              type: string;
              command?: string;
              tool?: string;
              arguments?: unknown;
              text?: string;
              id?: string;
              aggregated_output?: string;
              exit_code?: number;
              message?: string;
              status?: "in_progress" | "completed" | "failed";
              error?: { message?: string };
            };
            usage?: {
              input_tokens: number;
              output_tokens: number;
              cached_input_tokens?: number;
            };
            error?: { message?: string };
          };

          switch (event.type) {
            case "thread.started": {
              if (event.thread_id) {
                currentSessionId = event.thread_id;
                yield { type: "session", sessionId: event.thread_id };
              }
              break;
            }

            case "item.started": {
              const item = event.item;
              if (!item) break;
              if (item.type === "command_execution") {
                const command = String(item.command ?? "");
                yield {
                  type: "tool_use",
                  name: "Bash",
                  input: { command },
                  toolUseId: String(item.id ?? ""),
                };
              } else if (item.type === "mcp_tool_call") {
                yield {
                  type: "tool_use",
                  name: String(item.tool ?? "unknown"),
                  input:
                    item.arguments && typeof item.arguments === "object"
                      ? (item.arguments as Record<string, unknown>)
                      : {},
                  toolUseId: String(item.id ?? ""),
                };
              }
              break;
            }

            case "item.updated": {
              const item = event.item;
              if (!item) break;
              if (item.type === "agent_message") {
                const messageId = item.id != null ? String(item.id) : undefined;
                if (messageId !== currentAgentMessageId) {
                  currentAgentMessageId = messageId;
                  agentTextSoFar = "";
                }
                const text = String(item.text ?? "");
                const newChars = text.slice(agentTextSoFar.length);
                if (newChars) {
                  yield { type: "text_delta", content: newChars };
                  agentTextSoFar = text;
                }
              }
              break;
            }

            case "item.completed": {
              const item = event.item;
              if (!item) break;
              if (item.type === "agent_message") {
                finalText = String(item.text ?? "");
                agentTextSoFar = finalText;
                yield { type: "text", content: finalText };
                yield* extractFileEvents(finalText, "text");
              } else if (item.type === "reasoning") {
                const reasoning = String(item.text ?? "").trim();
                if (reasoning) yield { type: "reasoning", content: reasoning };
              } else if (item.type === "mcp_tool_call") {
                const isError = item.status === "failed" || Boolean(item.error);
                yield {
                  type: "tool_result",
                  toolUseId: String(item.id ?? ""),
                  content: summarizeMcpToolCallResult(item as unknown as McpToolCallItem),
                  ...(isError ? { isError: true } : {}),
                };
              } else if (item.type === "command_execution") {
                const isError =
                  item.status === "failed" ||
                  (typeof item.exit_code === "number" && item.exit_code !== 0);
                yield {
                  type: "tool_result",
                  toolUseId: String(item.id ?? ""),
                  content: String(item.aggregated_output ?? "").slice(0, 200),
                  ...(isError ? { isError: true } : {}),
                };
              } else if (item.type === "file_change") {
                const fileEvents = await fileChangeEvents(
                  item as unknown as FileChangeItem,
                  filePreviews,
                  opts.cwd,
                  currentSessionId,
                  consumedPatchCallIds,
                );
                for (const fileEvent of fileEvents) {
                  yield fileEvent;
                }
              } else if (item.type === "error") {
                yield { type: "error", content: String(item.message ?? "") };
              }
              break;
            }

            case "turn.completed": {
              const usage = event.usage;
              if (!usage) break;
              attemptCompleted = true;
              const contextUsage = currentSessionId
                ? readLatestCodexContextUsage(currentSessionId)
                : undefined;
              yield {
                type: "result",
                content: finalText,
                stopReason,
                usage: {
                  inputTokens: usage.input_tokens,
                  outputTokens: usage.output_tokens,
                  cacheReadInputTokens: usage.cached_input_tokens,
                  ...contextUsage,
                },
              };
              if (finalText) yield* extractFileEvents(finalText, "result");
              break;
            }

            case "turn.failed": {
              stopReason = "error";
              yield {
                type: "error",
                content: event.error?.message || "Codex turn failed",
              };
              break;
            }

            default:
              break;
          }
        }
      } catch (err) {
        if (abortSignal?.aborted) return;
        if (err instanceof Error && err.name === "AbortError") {
          if (!heartbeatTriggered) return;
          // Heartbeat abort — fall through to retry logic below
        } else {
          logger.error({ err }, "codexProvider: attempt failed");
          yield { type: "error", content: errMsg(err) };
          break;
        }
      } finally {
        if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
        abortSignal?.removeEventListener("abort", propagateOuter);
        if (trackedPids.pids.length > 0) unregisterOwnedCodexPids(trackedPids.pids);
      }

      if (attemptCompleted || abortSignal?.aborted) break;
      if (!heartbeatTriggered) break;

      heartbeatAttempts++;
      if (heartbeatAttempts > HEARTBEAT_MAX_ATTEMPTS) {
        logger.warn(
          { attempts: heartbeatAttempts },
          "codexProvider: max heartbeat attempts reached",
        );
        yield {
          type: "error",
          content: `Codex가 ${HEARTBEAT_MAX_ATTEMPTS}회 재시도 후에도 응답하지 않았습니다.`,
        };
        break;
      }

      heartbeatMs = Math.min(heartbeatMs * 2, HEARTBEAT_MAX_MS);
      logger.info(
        { attempt: heartbeatAttempts, nextIntervalMs: heartbeatMs },
        "codexProvider: heartbeat fired, resuming thread with continuation prompt",
      );

      // The resumed turn's agent_message grows from "" again. Stale lengths
      // from the aborted attempt would mis-slice deltas (silence until the new
      // text outgrows the old, then an arbitrary mid-string fragment), and a
      // resumed turn that ends without an agent_message would ship the
      // previous attempt's finalText as its result.
      agentTextSoFar = "";
      finalText = "";

      thread = currentSessionId
        ? codex.resumeThread(currentSessionId, threadOptions)
        : codex.startThread(threadOptions);
      prompt = currentSessionId ? HEARTBEAT_CONTINUATION : promptForThread(opts, true);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return;
    if (abortSignal?.aborted) return;
    logger.error({ err }, "codexProvider: setup failed");
    yield { type: "error", content: errMsg(err) };
  } finally {
    abortSignal?.removeEventListener("abort", onAbortKill);
    if (trackedPids.pids.length > 0) unregisterOwnedCodexPids(trackedPids.pids);
  }
}
