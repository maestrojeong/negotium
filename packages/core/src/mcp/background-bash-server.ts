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

/** Root for full-output spill files, one directory per bash id. */
const SPILL_ROOT = join(RUN_DIR, "bg-bash-output");

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
    `전체 ${formatBytes(snapshot.totalBytes)} 중 ${formatBytes(snapshot.omittedBytes)} 생략`,
  ];
  if (snapshot.spillPath) notes.push(`전체 출력: ${snapshot.spillPath}`);
  else notes.push(`전체 출력 저장 실패 (복구 불가): ${snapshot.spillError ?? "unknown"}`);
  return `${label} (${notes.join(" · ")}):\n${body}`;
}

/**
 * Deliver the completion turn.
 *
 * Returns false when the inbox write failed. The tool promises the caller it
 * need not poll, so a dropped completion is the one failure that leaves a
 * background job silently unfinished — the caller must not treat it as done.
 */
function injectCompletion(proc: BgProc): boolean {
  const parts: string[] = [];
  const stdout = describeStream("stdout", proc.stdout.snapshot());
  const stderr = describeStream("stderr", proc.stderr.snapshot());
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  const output = parts.join("\n") || "(출력 없음)";

  const message =
    `[background_bash ${proc.bashId} 완료]\n` +
    `커맨드: ${proc.command.slice(0, 200)}\n` +
    `종료 코드: ${proc.exitCode ?? "unknown"}\n` +
    output;

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
    process.stderr.write(`[bg-bash] injected completion ${proc.bashId} exit=${proc.exitCode}\n`);
    return true;
  } catch (e) {
    process.stderr.write(
      `[bg-bash] FAILED to deliver completion ${proc.bashId} (exit=${proc.exitCode}): ${e}\n` +
        `[bg-bash] the topic will never be told this job finished; ` +
        `its output is kept at ${spillDir(proc.bashId)}\n`,
    );
    return false;
  }
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
  const completed = [...procs.values()]
    // Undelivered jobs hold the only copy of output the topic never saw.
    .filter((proc) => proc.exited && proc.delivered)
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
  proc.delivered = injectCompletion(proc);
  if (proc.delivered) {
    proc.cleanupTimer = setTimeout(() => forgetProc(proc), COMPLETED_RETENTION_MS);
    proc.cleanupTimer.unref?.();
  }
  // An undelivered job keeps its registry entry and spill: `background_bash_
  // output` is the only way left to retrieve it, and expiring it on the normal
  // schedule would destroy the sole copy of output nobody has seen.
  pruneCompletedProcs();
}

function spawnBash(
  context: BgContext,
  command: string,
  cwd?: string,
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
  };
  // Raw Buffers: decoding per chunk would split multi-byte characters that
  // straddle a chunk boundary. The buffer decodes at read time instead.
  child.stdout?.on("data", (c: Buffer) => proc.stdout.append(c));
  child.stderr?.on("data", (c: Buffer) => proc.stderr.append(c));
  child.on("close", (code) => {
    finishProc(proc, code);
  });
  child.on("error", (err) => {
    proc.stderr.append(Buffer.from(`[spawn error]: ${err.message}\n`, "utf-8"));
    finishProc(proc, -1);
  });
  procs.set(bashId, proc);
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
