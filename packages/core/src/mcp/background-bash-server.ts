#!/usr/bin/env node
/**
 * Background Bash MCP server — HTTP mode (SSE + Streamable HTTP).
 *
 * Runs as a long-lived HTTP process managed by background-bash/manager.ts,
 * independent of any agent turn. Bash processes spawned here survive turn
 * boundaries; when a process exits its output is injected into the topic
 * via session-inbox so the model gets a new turn automatically.
 *
 * Endpoints:
 *   GET  /sse          → SSE MCP transport (claude / maestro)
 *   POST /message      → SSE message handler (claude / maestro)
 *   POST /mcp          → Streamable HTTP MCP transport (codex)
 *   GET  /health       → health probe (used by manager.ts)
 *
 * Why HTTP instead of stdio:
 *   stdio servers are children of the agent SDK subprocess and are killed
 *   when the turn ends. An HTTP server managed separately persists across
 *   turns so background bash processes have a stable owner and can inject
 *   completions asynchronously.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { deriveBgBashContextCapability } from "#platform/background-bash/context";
import {
  BoundedOutputStream,
  formatBytes,
  type OutputSnapshot,
} from "#platform/background-bash/output-buffer";
import { RUN_DIR } from "#platform/config";
import { appendJsonlEntry } from "#platform/jsonl";
import { sessionInboxPath } from "#query/session-inbox-path";
import { mcpError, mcpOk } from "./mcp-helpers";

// --- CLI args ---

const args = process.argv.slice(2);
const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "0", 10);
const runtimeCapability = process.env.NEGOTIUM_BG_BASH_CAPABILITY ?? "";
const runtimeServerId = process.env.NEGOTIUM_BG_BASH_SERVER_ID ?? "";

if (!port || !runtimeCapability || !runtimeServerId) {
  process.stderr.write(
    "FATAL: --port, NEGOTIUM_BG_BASH_CAPABILITY, and NEGOTIUM_BG_BASH_SERVER_ID are required\n",
  );
  process.exit(1);
}

// --- Process registry ---

const SIGTERM_GRACE_MS = 5_000;
/**
 * Preview budget per stream, in real UTF-8 bytes. Output beyond this is kept
 * only in the spill file, never dropped outright.
 */
const MAX_OUTPUT_BYTES = 200_000;
const COMPLETED_RETENTION_MS = 60 * 60_000;
const MAX_COMPLETED_PROCS = 100;
/** Count-based pruning ignores jobs this fresh; their turn may still be queued. */
const PRUNE_GRACE_MS = 5 * 60_000;
const DEFAULT_WATCH_TIMEOUT_SECONDS = 3_600;
const MAX_WATCH_TIMEOUT_SECONDS = 86_400;

/** Root for full-output spill files, one directory per bash id. */
const SPILL_ROOT = join(RUN_DIR, "bg-bash-output");

/**
 * One-shot match-and-notify state for `background_bash_watch`. `matched` and
 * `finished` are distinct: `matched` records the specific outcome (a line hit
 * `regex`) for the injected message; `finished` guards against `finishProc`
 * double-delivering once a match or timeout has already sent the one turn a
 * watch job promises.
 */
interface WatchState {
  regex: RegExp;
  target: "stdout" | "stderr" | "both";
  matched: boolean;
  finished: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  stdoutCarry: string;
  stderrCarry: string;
}

interface BgProc {
  bashId: string;
  userId: string;
  topic: string;
  command: string;
  child: ChildProcess;
  stdout: BoundedOutputStream;
  stderr: BoundedOutputStream;
  stdoutCursor: number;
  stderrCursor: number;
  exited: boolean;
  exitCode: number | null;
  /** False once the completion turn failed to reach the topic's inbox. */
  delivered: boolean;
  startedAt: number;
  killTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  /** Present only for jobs started via `background_bash_watch`. */
  watch?: WatchState;
}

const procs = new Map<string, BgProc>();

interface BgContext {
  userId: string;
  topic: string;
}

function contextCapability(context: BgContext): string {
  return deriveBgBashContextCapability(runtimeCapability, context.userId, context.topic);
}

function sameContext(proc: BgProc, context: BgContext): boolean {
  return proc.userId === context.userId && proc.topic === context.topic;
}

function newBashId(): string {
  return `bash_${randomBytes(6).toString("hex")}`;
}

function spillDir(bashId: string): string {
  return join(SPILL_ROOT, bashId);
}

function removeSpill(bashId: string): void {
  try {
    rmSync(spillDir(bashId), { recursive: true, force: true });
  } catch {
    // Best-effort: a leftover spill is swept on the next server start.
  }
}

/**
 * Drop spill directories left behind by a previous server process.
 *
 * Completed processes are forgotten after `COMPLETED_RETENTION_MS`, but a
 * crash or restart skips that cleanup, so anything older than the retention
 * window is unreachable and safe to remove.
 */
function sweepStaleSpills(): void {
  let entries: string[];
  try {
    entries = readdirSync(SPILL_ROOT);
  } catch {
    return; // Nothing spilled yet.
  }
  const cutoff = Date.now() - COMPLETED_RETENTION_MS;
  for (const entry of entries) {
    if (procs.has(entry)) continue;
    const path = join(SPILL_ROOT, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      // Ignore races with a concurrent sweep.
    }
  }
}

/**
 * Render one stream for the completion turn.
 *
 * Reports the real total, what was dropped from the preview, and where the
 * complete bytes live. When the spill failed we say so instead of pointing at
 * a file that does not hold the full output.
 */
function describeStream(label: string, snapshot: OutputSnapshot): string | undefined {
  const body = snapshot.text.trim();
  if (!body && !snapshot.truncated) return undefined;
  if (!snapshot.truncated) return `${label}:\n${body}`;

  const notes = [
    `${formatBytes(snapshot.totalBytes)} total, ${formatBytes(snapshot.omittedBytes)} omitted`,
  ];
  if (snapshot.spillPath) {
    // The path is only good while the completed process is retained. Saying so
    // lets a reader that comes back later know why the file is gone.
    notes.push(
      `full output: ${snapshot.spillPath} ` +
        `(deleted in ~${Math.round(COMPLETED_RETENTION_MS / 60_000)} min)`,
    );
  } else {
    notes.push(
      `full output could NOT be saved, unrecoverable: ${snapshot.spillError ?? "unknown"}`,
    );
  }
  return `${label} (${notes.join(" · ")}):\n${body}`;
}

/** Render the shared header+output body used by every injected message. */
function buildOutputMessage(proc: BgProc, header: string): string {
  const parts: string[] = [];
  const stdout = describeStream("stdout", proc.stdout.snapshot());
  const stderr = describeStream("stderr", proc.stderr.snapshot());
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  const output = parts.join("\n") || "(no output)";
  // English on purpose: this text is injected into the model's context, and
  // every other model-facing string in this server — the tool descriptions it
  // sits alongside — is English. It is also cheaper in tokens.
  return (
    `${header}\n` +
    `command: ${proc.command.slice(0, 200)}\n` +
    `exit code: ${proc.exitCode ?? "unknown"}\n` +
    output
  );
}

/**
 * Deliver one turn to the topic's inbox.
 *
 * Returns false when the inbox write failed. Every caller promises the
 * caller it need not poll, so a dropped delivery is the one failure that
 * leaves a background job silently unfinished — treat it as not-done.
 */
function injectMessage(proc: BgProc, message: string, label: string): boolean {
  // `proc.topic` is the canonical topic id (see mcp-config background-bash
  // build: `topicId ?? session`). Route through the shared helper so the
  // filename is the `topic-id-{base64url}` form the session-inbox worker
  // decodes back to a topic id — a bare `${topic}.jsonl` is misread as a
  // topic *title* and silently dropped when no topic has that title.
  try {
    appendJsonlEntry(sessionInboxPath(proc.userId, proc.topic), {
      type: "tell",
      from: "__bg_bash__",
      message,
      depth: 0,
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(`[bg-bash] injected ${label} ${proc.bashId} exit=${proc.exitCode}\n`);
    return true;
  } catch (e) {
    process.stderr.write(
      `[bg-bash] FAILED to deliver ${label} ${proc.bashId} (exit=${proc.exitCode}): ${e}\n` +
        `[bg-bash] the topic will never be told this job finished; ` +
        `its output is kept at ${spillDir(proc.bashId)}\n`,
    );
    return false;
  }
}

function injectCompletion(proc: BgProc): boolean {
  return injectMessage(
    proc,
    buildOutputMessage(proc, `[background_bash ${proc.bashId} finished]`),
    "completion",
  );
}

/**
 * Test newly arrived bytes for `watch.regex`, line by line, carrying any
 * trailing partial line to the next chunk so a match split across two reads
 * is never missed. Returns the first matching line, if any.
 */
function checkWatchMatch(
  proc: BgProc,
  stream: "stdout" | "stderr",
  chunk: Buffer,
): string | undefined {
  const watch = proc.watch;
  if (!watch || watch.matched) return undefined;
  if (watch.target !== "both" && watch.target !== stream) return undefined;
  const carryKey = stream === "stdout" ? "stdoutCarry" : "stderrCarry";
  const lines = (watch[carryKey] + chunk.toString("utf8")).split("\n");
  watch[carryKey] = lines.pop() ?? "";
  for (const line of lines) {
    if (watch.regex.test(line)) return line;
  }
  return undefined;
}

/** A watch line matched: deliver the one promised turn and stop the process. */
function handleWatchMatch(proc: BgProc, line: string): void {
  const watch = proc.watch;
  if (!watch || watch.matched) return;
  watch.matched = true;
  watch.finished = true;
  if (watch.timeoutTimer) {
    clearTimeout(watch.timeoutTimer);
    watch.timeoutTimer = undefined;
  }
  const header = `[background_bash_watch ${proc.bashId} matched]\nmatched line: ${line.slice(0, 500)}`;
  proc.delivered = injectMessage(proc, buildOutputMessage(proc, header), "watch match");
  terminateProc(proc);
}

/** No line matched within the deadline: deliver a timeout turn and stop. */
function handleWatchTimeout(proc: BgProc): void {
  const watch = proc.watch;
  if (!watch || watch.finished) return;
  watch.finished = true;
  const header = `[background_bash_watch ${proc.bashId} timed out without a match]`;
  proc.delivered = injectMessage(proc, buildOutputMessage(proc, header), "watch timeout");
  terminateProc(proc);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return child.kill(signal);
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      process.kill(child.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function forgetProc(proc: BgProc): void {
  if (procs.get(proc.bashId) !== proc) return;
  if (proc.cleanupTimer) clearTimeout(proc.cleanupTimer);
  procs.delete(proc.bashId);
  // The spill is only reachable through this registry entry, so its lifetime
  // is the completed-process retention lifetime.
  proc.stdout.close();
  proc.stderr.close();
  removeSpill(proc.bashId);
}

function pruneCompletedProcs(): void {
  // A burst of short high-output jobs could otherwise evict a spill seconds
  // after its completion turn was queued but before the topic consumed it.
  const evictableBefore = Date.now() - PRUNE_GRACE_MS;
  const completed = [...procs.values()]
    // Undelivered jobs hold the only copy of output the topic never saw.
    .filter((proc) => proc.exited && proc.delivered && proc.startedAt < evictableBefore)
    .sort((a, b) => a.startedAt - b.startedAt);
  while (completed.length > MAX_COMPLETED_PROCS) {
    const oldest = completed.shift();
    if (oldest) forgetProc(oldest);
  }
}

function terminateProc(proc: BgProc): boolean {
  if (proc.exited) return false;
  const signalled = signalProcessTree(proc.child, "SIGTERM");
  if (!proc.killTimer) {
    proc.killTimer = setTimeout(() => {
      if (!proc.exited) signalProcessTree(proc.child, "SIGKILL");
    }, SIGTERM_GRACE_MS);
    proc.killTimer.unref?.();
  }
  return signalled;
}

function finishProc(proc: BgProc, exitCode: number | null): void {
  if (proc.exited) return;
  proc.exited = true;
  proc.exitCode = exitCode;
  if (proc.killTimer) {
    clearTimeout(proc.killTimer);
    proc.killTimer = undefined;
  }
  // Release the spill descriptors before the completion turn quotes their
  // paths, so anything reading them sees a closed, complete file.
  proc.stdout.close();
  proc.stderr.close();
  if (proc.watch) {
    if (proc.watch.timeoutTimer) {
      clearTimeout(proc.watch.timeoutTimer);
      proc.watch.timeoutTimer = undefined;
    }
    if (!proc.watch.finished) {
      // The command exited on its own — no match, no timeout yet. This is
      // still exactly one delivered turn, same one-shot guarantee.
      proc.watch.finished = true;
      const header = `[background_bash_watch ${proc.bashId} exited before matching]`;
      proc.delivered = injectMessage(proc, buildOutputMessage(proc, header), "watch exit");
    }
    // Else: a match or timeout already delivered the one promised turn
    // (`proc.delivered` was set there) — do not inject a second one.
  } else {
    proc.delivered = injectCompletion(proc);
  }
  if (proc.delivered) {
    proc.cleanupTimer = setTimeout(() => forgetProc(proc), COMPLETED_RETENTION_MS);
    proc.cleanupTimer.unref?.();
  }
  // An undelivered job keeps its registry entry and spill: `background_bash_
  // output` is the only way left to retrieve it, and expiring it on the normal
  // schedule would destroy the sole copy of output nobody has seen.
  pruneCompletedProcs();
}

interface WatchConfig {
  regex: RegExp;
  target: "stdout" | "stderr" | "both";
  timeoutSeconds: number;
}

function spawnBash(
  context: BgContext,
  command: string,
  cwd?: string,
  watchConfig?: WatchConfig,
): { bashId: string } | { error: string } {
  if (!command.trim()) return { error: "empty command" };
  const bashId = newBashId();
  let child: ChildProcess;
  try {
    child = spawn("bash", ["-c", command], {
      ...(cwd ? { cwd } : {}),
      detached: true,
      env: process.env,
    });
  } catch (e) {
    return { error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const dir = spillDir(bashId);
  const proc: BgProc = {
    bashId,
    userId: context.userId,
    topic: context.topic,
    command,
    child,
    stdout: new BoundedOutputStream({
      maxBytes: MAX_OUTPUT_BYTES,
      spillPath: join(dir, "stdout.log"),
    }),
    stderr: new BoundedOutputStream({
      maxBytes: MAX_OUTPUT_BYTES,
      spillPath: join(dir, "stderr.log"),
    }),
    stdoutCursor: 0,
    stderrCursor: 0,
    exited: false,
    exitCode: null,
    delivered: false,
    startedAt: Date.now(),
    watch: watchConfig
      ? {
          regex: watchConfig.regex,
          target: watchConfig.target,
          matched: false,
          finished: false,
          stdoutCarry: "",
          stderrCarry: "",
        }
      : undefined,
  };
  // Raw Buffers: decoding per chunk would split multi-byte characters that
  // straddle a chunk boundary. The buffer decodes at read time instead.
  child.stdout?.on("data", (c: Buffer) => {
    proc.stdout.append(c);
    const line = checkWatchMatch(proc, "stdout", c);
    if (line !== undefined) handleWatchMatch(proc, line);
  });
  child.stderr?.on("data", (c: Buffer) => {
    proc.stderr.append(c);
    const line = checkWatchMatch(proc, "stderr", c);
    if (line !== undefined) handleWatchMatch(proc, line);
  });
  child.on("close", (code) => {
    finishProc(proc, code);
  });
  child.on("error", (err) => {
    proc.stderr.append(Buffer.from(`[spawn error]: ${err.message}\n`, "utf-8"));
    finishProc(proc, -1);
  });
  procs.set(bashId, proc);
  if (proc.watch) {
    proc.watch.timeoutTimer = setTimeout(
      () => handleWatchTimeout(proc),
      watchConfig!.timeoutSeconds * 1_000,
    );
    proc.watch.timeoutTimer.unref?.();
  }
  process.stderr.write(`[bg-bash] started ${bashId}: ${command.slice(0, 80)}\n`);
  return { bashId };
}

process.on("exit", () => {
  for (const proc of procs.values()) {
    if (!proc.exited) signalProcessTree(proc.child, "SIGKILL");
  }
});

// --- MCP tool factory (shared registry via closure, one instance per connection) ---

function buildMcpServer(context: BgContext): McpServer {
  const server = new McpServer({ name: "background-bash", version: "1.0.0" });

  server.tool(
    "background_bash_run",
    [
      "Start a long-running shell command in the background. Returns bash_id immediately.",
      "Use this only for independent commands expected to run longer than about 2 minutes or survive beyond the current agent turn.",
      "Run ordinary builds, tests, and commands whose result is needed for the next step in the foreground; do not use this merely to avoid waiting.",
      "The process runs independently of this agent turn.",
      "When it exits, its output is injected into this session as a new turn.",
      `Each stream is previewed up to ${Math.floor(MAX_OUTPUT_BYTES / 1024)} KiB (head + tail);`,
      "when output exceeds that, the preview states how much was omitted and gives the path of a",
      "spill file holding the complete stdout/stderr, readable until the process is pruned.",
      "You do NOT need to poll for completion — just start it and continue.",
      "Use background_bash_output to peek at live output, background_bash_kill to terminate early.",
    ].join(" "),
    {
      command: z.string().describe("Shell command (executed via bash -c)"),
      cwd: z.string().optional().describe("Working directory (absolute path)"),
    },
    async ({ command, cwd }) => {
      const result = spawnBash(context, command, cwd);
      if ("error" in result) return mcpError(result.error);
      return mcpOk(JSON.stringify({ bash_id: result.bashId, status: "started" }));
    },
  );

  server.tool(
    "background_bash_output",
    [
      "Poll incremental stdout/stderr since the last call. Returns only new bytes plus exited/exitCode.",
      "stdoutDropped/stderrDropped count bytes that scrolled out of the live window before this call",
      "reached them; read stdoutPath/stderrPath for the complete output when that happens.",
    ].join(" "),
    { bash_id: z.string().describe("bash_id from background_bash_run") },
    async ({ bash_id }) => {
      const proc = procs.get(bash_id);
      if (!proc || !sameContext(proc, context)) return mcpError(`Unknown bash_id: ${bash_id}`);
      const out = proc.stdout.readSince(proc.stdoutCursor);
      const err = proc.stderr.readSince(proc.stderrCursor);
      proc.stdoutCursor = out.nextCursor;
      proc.stderrCursor = err.nextCursor;
      return mcpOk(
        JSON.stringify({
          bash_id,
          exited: proc.exited,
          exitCode: proc.exitCode,
          stdout: out.text,
          stderr: err.text,
          ...(out.droppedBytes ? { stdoutDropped: out.droppedBytes } : {}),
          ...(err.droppedBytes ? { stderrDropped: err.droppedBytes } : {}),
          ...(proc.stdout.spillPath ? { stdoutPath: proc.stdout.spillPath } : {}),
          ...(proc.stderr.spillPath ? { stderrPath: proc.stderr.spillPath } : {}),
        }),
      );
    },
  );

  server.tool(
    "background_bash_watch",
    [
      "Start a background shell command and watch its stdout/stderr for a regex match, one line at a time.",
      "The moment a line matches `match`, the process is stopped and the matching line plus buffered",
      "output is injected into this session as a new turn — you do NOT need to poll.",
      "If nothing matches within `timeout_seconds` (default 3600), or the command exits on its own first,",
      "a final status turn is injected instead. Exactly one turn is ever injected per watch — this is",
      "one-shot only, there is no repeat/streaming mode yet.",
      "Prefer this over `background_bash_run` + manual `background_bash_output` polling when you are",
      "waiting for a specific condition to appear (a deploy readiness line, an error) rather than for",
      "the command itself to finish.",
    ].join(" "),
    {
      command: z.string().describe("Shell command (executed via bash -c)"),
      match: z.string().describe("Regular expression tested against each output line"),
      cwd: z.string().optional().describe("Working directory (absolute path)"),
      stream: z
        .enum(["stdout", "stderr", "both"])
        .optional()
        .describe("Which stream(s) to test against `match` (default both)"),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(MAX_WATCH_TIMEOUT_SECONDS)
        .optional()
        .describe(
          `Give up waiting for a match after this many seconds (default ${DEFAULT_WATCH_TIMEOUT_SECONDS}, max ${MAX_WATCH_TIMEOUT_SECONDS})`,
        ),
    },
    async ({ command, match, cwd, stream, timeout_seconds }) => {
      let regex: RegExp;
      try {
        regex = new RegExp(match);
      } catch (e) {
        return mcpError(
          `invalid regex in \`match\`: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const result = spawnBash(context, command, cwd, {
        regex,
        target: stream ?? "both",
        timeoutSeconds: timeout_seconds ?? DEFAULT_WATCH_TIMEOUT_SECONDS,
      });
      if ("error" in result) return mcpError(result.error);
      return mcpOk(JSON.stringify({ bash_id: result.bashId, status: "watching" }));
    },
  );

  server.tool(
    "background_bash_kill",
    "Terminate a background process (SIGTERM → SIGKILL after 5s). Idempotent.",
    { bash_id: z.string().describe("bash_id to kill") },
    async ({ bash_id }) => {
      const proc = procs.get(bash_id);
      if (!proc || !sameContext(proc, context)) return mcpError(`Unknown bash_id: ${bash_id}`);
      if (proc.exited)
        return mcpOk(JSON.stringify({ bash_id, alreadyExited: true, exitCode: proc.exitCode }));
      terminateProc(proc);
      return mcpOk(JSON.stringify({ bash_id, killed: true }));
    },
  );

  return server;
}

// --- HTTP server ---

// SSE: track active transports so POST /message can route back to them
const sseTransports = new Map<string, SSEServerTransport>();
const streamableTransports = new Map<string, StreamableHTTPServerTransport>();

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function writeJsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

function requestContext(req: IncomingMessage, url: URL): BgContext | null {
  const userId =
    firstHeader(req.headers["x-background-bash-user"]) || url.searchParams.get("user") || "";
  const topic =
    firstHeader(req.headers["x-background-bash-topic"]) || url.searchParams.get("topic") || "";
  const capability =
    firstHeader(req.headers["x-background-bash-capability"]) ||
    url.searchParams.get("capability") ||
    "";
  if (!userId || !topic || !capability) return null;
  const context = { userId, topic };
  const expected = contextCapability(context);
  const actualBytes = Buffer.from(capability);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
    return null;
  return context;
}

const httpServer = createServer(async (req, res) => {
  const urlStr = req.url ?? "/";
  const url = new URL(urlStr, `http://127.0.0.1:${port}`);

  // Health probe
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end(runtimeServerId);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/contexts") {
    const context = requestContext(req, url);
    if (!context) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let killed = 0;
    for (const proc of procs.values()) {
      if (!proc.exited && sameContext(proc, context) && terminateProc(proc)) killed++;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ killed }));
    return;
  }

  // SSE endpoint (claude / maestro)
  if (req.method === "GET" && url.pathname === "/sse") {
    const context = requestContext(req, url);
    if (!context) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const transport = new SSEServerTransport("/message", res);
    const server = buildMcpServer(context);
    sseTransports.set(transport.sessionId, transport);
    transport.onclose = () => sseTransports.delete(transport.sessionId);
    await server.connect(transport);
    return;
  }

  // SSE POST message handler
  if (req.method === "POST" && url.pathname === "/message") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.writeHead(404).end("session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  // Streamable HTTP endpoint (codex)
  if (url.pathname === "/mcp") {
    const sessionId = firstHeader(req.headers["mcp-session-id"]);
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId) {
      transport = streamableTransports.get(sessionId);
      if (!transport) {
        writeJsonError(res, 404, "Session not found");
        return;
      }
    } else if (req.method === "POST") {
      const context = requestContext(req, url);
      if (!context) {
        writeJsonError(res, 403, "Forbidden");
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (transport) streamableTransports.set(id, transport);
        },
      });
      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id) streamableTransports.delete(id);
      };
      transport.onerror = (err) => {
        process.stderr.write(`[bg-bash] streamable transport error: ${err.message}\n`);
      };
      const server = buildMcpServer(context);
      await server.connect(transport);
    } else {
      writeJsonError(res, 400, "Mcp-Session-Id header is required");
      return;
    }

    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404).end();
});

httpServer.listen(port, "127.0.0.1", () => {
  sweepStaleSpills();
  process.stderr.write(`[bg-bash] shared runtime listening on 127.0.0.1:${port}\n`);
});
