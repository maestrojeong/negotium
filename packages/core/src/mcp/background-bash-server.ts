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
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { SESSION_INBOX_DIR } from "#platform/config";
import { appendJsonlEntry } from "#platform/jsonl";
import { mcpError, mcpOk, parseUserIdArg } from "./mcp-helpers";

// --- CLI args ---

const args = process.argv.slice(2);
const userId = parseUserIdArg(args);
const topic = args.find((a) => a.startsWith("--topic="))?.split("=")[1] ?? "";
const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "0", 10);

if (!userId || !topic || !port) {
  process.stderr.write("FATAL: --user-id, --topic, --port are required\n");
  process.exit(1);
}

// --- Process registry ---

const SIGTERM_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 200_000;

interface BgProc {
  bashId: string;
  command: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  stdoutCursor: number;
  stderrCursor: number;
  exited: boolean;
  exitCode: number | null;
  startedAt: number;
  killTimer?: ReturnType<typeof setTimeout>;
}

const procs = new Map<string, BgProc>();

function newBashId(): string {
  return `bash_${randomBytes(6).toString("hex")}`;
}

function appendBounded(proc: BgProc, stream: "stdout" | "stderr", chunk: string): void {
  const next = proc[stream] + chunk;
  if (next.length <= MAX_OUTPUT_BYTES) {
    proc[stream] = next;
    return;
  }
  const half = Math.floor(MAX_OUTPUT_BYTES / 2);
  proc[stream] = `${next.slice(0, half)}\n…[truncated]…\n${next.slice(-half)}`;
}

function injectCompletion(proc: BgProc): void {
  const stdout = proc.stdout.trim();
  const stderr = proc.stderr.trim();
  const parts: string[] = [];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  const output = parts.join("\n") || "(출력 없음)";

  const message =
    `[background_bash ${proc.bashId} 완료]\n` +
    `커맨드: ${proc.command.slice(0, 200)}\n` +
    `종료 코드: ${proc.exitCode ?? "unknown"}\n` +
    output;

  const dir = join(SESSION_INBOX_DIR, userId);
  try {
    appendJsonlEntry(join(dir, `${topic}.jsonl`), {
      type: "tell",
      from: "__bg_bash__",
      message,
      depth: 0,
      timestamp: new Date().toISOString(),
    });
    process.stderr.write(`[bg-bash] injected completion ${proc.bashId} exit=${proc.exitCode}\n`);
  } catch (e) {
    process.stderr.write(`[bg-bash] session-inbox write failed: ${e}\n`);
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

function finishProc(proc: BgProc, exitCode: number | null): void {
  if (proc.exited) return;
  proc.exited = true;
  proc.exitCode = exitCode;
  if (proc.killTimer) {
    clearTimeout(proc.killTimer);
    proc.killTimer = undefined;
  }
  injectCompletion(proc);
}

function spawnBash(command: string, cwd?: string): { bashId: string } | { error: string } {
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
  const proc: BgProc = {
    bashId,
    command,
    child,
    stdout: "",
    stderr: "",
    stdoutCursor: 0,
    stderrCursor: 0,
    exited: false,
    exitCode: null,
    startedAt: Date.now(),
  };
  child.stdout?.on("data", (c: Buffer) => appendBounded(proc, "stdout", c.toString("utf-8")));
  child.stderr?.on("data", (c: Buffer) => appendBounded(proc, "stderr", c.toString("utf-8")));
  child.on("close", (code) => {
    finishProc(proc, code);
  });
  child.on("error", (err) => {
    appendBounded(proc, "stderr", `[spawn error]: ${err.message}\n`);
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

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "background-bash", version: "1.0.0" });

  server.tool(
    "background_bash_run",
    [
      "Start a long-running shell command in the background. Returns bash_id immediately.",
      "The process runs independently of this agent turn.",
      "When it exits, the full output is automatically injected into this session as a new turn.",
      "You do NOT need to poll for completion — just start it and continue.",
      "Use background_bash_output to peek at live output, background_bash_kill to terminate early.",
    ].join(" "),
    {
      command: z.string().describe("Shell command (executed via bash -c)"),
      cwd: z.string().optional().describe("Working directory (absolute path)"),
    },
    async ({ command, cwd }) => {
      const result = spawnBash(command, cwd);
      if ("error" in result) return mcpError(result.error);
      return mcpOk(JSON.stringify({ bash_id: result.bashId, status: "started" }));
    },
  );

  server.tool(
    "background_bash_output",
    "Poll incremental stdout/stderr since the last call. Returns only new bytes plus exited/exitCode.",
    { bash_id: z.string().describe("bash_id from background_bash_run") },
    async ({ bash_id }) => {
      const proc = procs.get(bash_id);
      if (!proc) return mcpError(`Unknown bash_id: ${bash_id}`);
      const newStdout = proc.stdout.slice(proc.stdoutCursor);
      const newStderr = proc.stderr.slice(proc.stderrCursor);
      proc.stdoutCursor = proc.stdout.length;
      proc.stderrCursor = proc.stderr.length;
      return mcpOk(
        JSON.stringify({
          bash_id,
          exited: proc.exited,
          exitCode: proc.exitCode,
          stdout: newStdout,
          stderr: newStderr,
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
      if (!proc) return mcpError(`Unknown bash_id: ${bash_id}`);
      if (proc.exited)
        return mcpOk(JSON.stringify({ bash_id, alreadyExited: true, exitCode: proc.exitCode }));
      signalProcessTree(proc.child, "SIGTERM");
      proc.killTimer = setTimeout(() => {
        if (!proc.exited) signalProcessTree(proc.child, "SIGKILL");
      }, SIGTERM_GRACE_MS);
      proc.killTimer.unref?.();
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

const httpServer = createServer(async (req, res) => {
  const urlStr = req.url ?? "/";
  const url = new URL(urlStr, `http://127.0.0.1:${port}`);

  // Health probe
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  // SSE endpoint (claude / maestro)
  if (req.method === "GET" && url.pathname === "/sse") {
    const transport = new SSEServerTransport("/message", res);
    const server = buildMcpServer();
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
      const server = buildMcpServer();
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
  process.stderr.write(
    `[bg-bash] listening on 127.0.0.1:${port} (user=${userId} topic=${topic})\n`,
  );
});
