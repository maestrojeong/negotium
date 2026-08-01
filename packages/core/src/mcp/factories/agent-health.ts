import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { claudeRegistry } from "#agents/claude-registry";
import { codexRegistry } from "#agents/codex-registry";
import type { AgentRegistry } from "#agents/contracts";
import { maestroRegistry } from "#agents/maestro-registry";
import { ACTIVE_QUERY_STALE_MS, resolveDefaultModel, USERS_LOG_DIR } from "#platform/config";
import { errMsg } from "#platform/error";
import { readJsonFile } from "#platform/jsonl";
import type { AgentKind, QueryState } from "#types";
import { mcpOk } from "../mcp-helpers";

export interface AgentHealthMcpContext {
  userId?: string;
}

interface CheckResult {
  agent: string;
  model: string;
  ok: boolean;
  latency: number;
  detail?: string;
  error?: string;
  category?: string;
}

type CheckerFn = (model: string, timeoutMs: number, signal: AbortSignal) => Promise<CheckResult>;

function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

function spawnCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const forceKill = () => signalProcessTree(child, "SIGKILL");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (settled) return;
      settled = true;
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        forceKill();
        killTimer = undefined;
      }, 1_000);
      killTimer.unref?.();
      reject(new Error(reason));
    };
    const timeout = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code, exitSignal) => {
      cleanup();
      if (settled) {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        return;
      }
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${cmd} exited with ${code ?? exitSignal}`));
    });
  });
}

function resultOk(agent: string, model: string, latency: number, detail: string): CheckResult {
  return { agent, model, ok: true, latency, detail };
}

function resultFail(agent: string, model: string, latency: number, error: string): CheckResult {
  let category = "unknown";
  const normalized = error.toLowerCase();
  if (
    normalized.includes("auth") ||
    normalized.includes("key") ||
    normalized.includes("credential") ||
    normalized.includes("unauthorized")
  ) {
    category = "auth_error";
  } else if (
    normalized.includes("rate") ||
    normalized.includes("limit") ||
    normalized.includes("busy") ||
    normalized.includes("overloaded")
  ) {
    category = "rate_limit";
  } else if (
    normalized.includes("network") ||
    normalized.includes("refused") ||
    normalized.includes("dns") ||
    normalized.includes("timeout")
  ) {
    category = "network_error";
  }
  return { agent, model, ok: false, latency, error, category };
}

async function checkClaude(
  model: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    const args = ["-p", "say OK", "--model", model, "--max-turns", "1", "--output-format", "text"];
    const { stdout, stderr } = await spawnCapture("claude", args, timeoutMs, signal);
    const elapsed = Math.round(performance.now() - start);
    const text = (stdout + stderr).trim().slice(0, 200);
    if (!text) return resultFail("claude", model, elapsed, "empty response");
    return resultOk("claude", model, elapsed, text);
  } catch (err) {
    return resultFail("claude", model, Math.round(performance.now() - start), errMsg(err));
  }
}

async function checkCodex(
  model: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    const args = [
      "exec",
      "--model",
      model,
      "--skip-git-repo-check",
      "--sandbox",
      "danger-full-access",
      "say OK",
    ];
    const { stdout, stderr } = await spawnCapture("codex", args, timeoutMs, signal, {
      ...process.env,
      CODEX_NO_COLOR: "1",
    });
    const elapsed = Math.round(performance.now() - start);
    const combined = (stdout + stderr).trim();
    const match = combined.match(/\ncodex\s*\n(.+?)(?:\n(?:tokens|session|user|$))/);
    return resultOk("codex", model, elapsed, match ? match[1].trim().slice(0, 200) : "OK");
  } catch (err) {
    return resultFail("codex", model, Math.round(performance.now() - start), errMsg(err));
  }
}

async function checkMaestro(
  model: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CheckResult> {
  const start = performance.now();
  let iterator: AsyncIterator<any> | undefined;
  try {
    const { maestroProvider } = await import("maestro-agent-sdk");
    const generator = (maestroProvider as any)({
      model,
      prompt: "say OK",
      cwd: process.cwd(),
      maxTurns: 1,
    });
    const deadline = Date.now() + timeoutMs;
    const activeIterator = generator[Symbol.asyncIterator]() as AsyncIterator<any>;
    iterator = activeIterator;
    let text = "";
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timeout");
      const eventResult = await new Promise<IteratorResult<any>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), remaining);
        const onAbort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        void activeIterator
          .next()
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
          });
      });
      if (eventResult.done) break;
      const event = eventResult.value;
      if (event.type === "text" && event.content) text = event.content.slice(0, 200);
      if (event.type === "error") {
        return resultFail(
          "maestro",
          model,
          Math.round(performance.now() - start),
          event.error || "unknown error",
        );
      }
    }
    return resultOk(
      "maestro",
      model,
      Math.round(performance.now() - start),
      text || "(empty response)",
    );
  } catch (err) {
    return resultFail("maestro", model, Math.round(performance.now() - start), errMsg(err));
  } finally {
    if (iterator?.return) {
      try {
        await iterator.return();
      } catch {
        // The provider may already have closed the iterator.
      }
    }
  }
}

function getDefaultModel(registry: AgentRegistry): string {
  return resolveDefaultModel(registry.kind, registry.defaultModel);
}

const AGENTS: { kind: AgentKind; registry: AgentRegistry; checker: CheckerFn }[] = [
  { kind: "claude", registry: claudeRegistry, checker: checkClaude },
  { kind: "codex", registry: codexRegistry, checker: checkCodex },
  { kind: "maestro", registry: maestroRegistry, checker: checkMaestro },
];

const MAX_CONCURRENT_CHECKS = 2;
let activeChecks = 0;
const checkWaiters: Array<() => void> = [];
const activeCheckAllUsers = new Set<string>();

async function withCheckSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeChecks >= MAX_CONCURRENT_CHECKS) {
    await new Promise<void>((resolve) => checkWaiters.push(resolve));
  }
  activeChecks += 1;
  try {
    return await operation();
  } finally {
    activeChecks -= 1;
    checkWaiters.shift()?.();
  }
}

export function createAgentHealthMcpServer(context: AgentHealthMcpContext): McpServer {
  const server = new McpServer({ name: "agent-health", version: "1.0.0" });
  const abortController = new AbortController();
  const originalClose = server.close.bind(server);
  server.close = async () => {
    abortController.abort();
    await originalClose();
  };

  server.tool(
    "check_agent",
    "실제 API 호출로 특정 agent+model 조합이 정상 동작하는지 체크합니다.",
    {
      agent: z.enum(["claude", "codex", "maestro"]).describe("체크할 agent"),
      model: z.string().optional().describe("체크할 모델 (없으면 agent별 default 사용)"),
      timeoutMs: z.number().default(30000).describe("타임아웃 (ms), 기본 30초"),
    },
    async ({ agent, model, timeoutMs }) => {
      const entry = AGENTS.find((candidate) => candidate.kind === agent);
      if (!entry) return mcpOk(`Unknown agent: ${agent}`);
      const resolvedModel = model || getDefaultModel(entry.registry);
      const result = await withCheckSlot(() =>
        entry.checker(resolvedModel, timeoutMs, abortController.signal),
      );
      if (result.ok) {
        return mcpOk(
          `OK  ${result.agent} / ${result.model}\n   latency: ${result.latency}ms\n   detail: ${result.detail}`,
        );
      }
      return mcpOk(
        `FAIL  ${result.agent} / ${result.model}  [${result.category}]\n   latency: ${result.latency}ms\n   error: ${result.error}`,
      );
    },
  );

  server.tool(
    "check_all",
    "모든 agent (claude, codex, maestro)를 기본 모델로 동시에 체크합니다.",
    { timeoutMs: z.number().default(30000).describe("agent별 타임아웃 (ms), 기본 30초") },
    async ({ timeoutMs }) => {
      const userKey = context.userId ?? "unscoped";
      if (activeCheckAllUsers.has(userKey)) {
        return mcpOk("FAIL check_all is already running for this user");
      }
      activeCheckAllUsers.add(userKey);
      try {
        const results = await Promise.all(
          AGENTS.map(async (entry) =>
            withCheckSlot(() =>
              entry.checker(getDefaultModel(entry.registry), timeoutMs, abortController.signal),
            ),
          ),
        );
        const lines = results.map((result) =>
          result.ok
            ? `OK   ${result.agent.padEnd(8)} / ${result.model.padEnd(14)} ${result.latency}ms  ${result.detail}`
            : `FAIL ${result.agent.padEnd(8)} / ${result.model.padEnd(14)} ${result.latency}ms  [${result.category}] ${result.error}`,
        );
        return mcpOk(
          `Agent/Model Health Check\n${lines.join("\n")}\n\n${results.every((result) => result.ok) ? "All agents healthy" : "Some agents failed"}`,
        );
      } finally {
        activeCheckAllUsers.delete(userKey);
      }
    },
  );

  server.tool(
    "list_active_queries",
    "현재 사용자 범위에서 실행 중인 토픽 쿼리 목록을 조회합니다.",
    {},
    async () => {
      if (!context.userId) return mcpOk("실행 중인 쿼리 조회 불가 (user context 없음)");
      const stateDir = join(USERS_LOG_DIR, context.userId, "active-queries");
      if (!existsSync(stateDir)) return mcpOk("실행 중인 쿼리 없음");

      let files: string[];
      try {
        files = readdirSync(stateDir);
      } catch {
        return mcpOk("실행 중인 쿼리 없음");
      }

      const now = Date.now();
      const entries = files.flatMap((file) => {
        if (!file.endsWith(".json")) return [];
        const state = readJsonFile<QueryState>(join(stateDir, file));
        if (!state) return [];
        const sinceMs = new Date(state.since).getTime();
        if (now - sinceMs > ACTIVE_QUERY_STALE_MS) return [];
        return [
          {
            topicName: state.topicName ?? file.slice(0, -5),
            elapsedSec: Math.round((now - sinceMs) / 1000),
            task: state.task,
          },
        ];
      });
      if (entries.length === 0) return mcpOk("실행 중인 쿼리 없음");
      const lines = entries.map(
        (entry) =>
          `• ${entry.topicName} | ${entry.elapsedSec}s 경과${entry.task ? `  "${entry.task}"` : ""}`,
      );
      return mcpOk(`실행 중인 쿼리 (${entries.length}개)\n${lines.join("\n")}`);
    },
  );

  return server;
}
