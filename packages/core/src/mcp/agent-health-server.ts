#!/usr/bin/env node
/**
 * Agent Health Check MCP Server
 *
 * 각 agent (claude, codex, maestro)와 model이 실제 API 호출 시
 * 정상 동작하는지 검증합니다.
 * API key 에러, rate limit, network error, timeout 등을 감지합니다.
 *
 * Scopes: forum, manager (general 방)
 */

import "./stdio-protect";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { maestroProvider } from "maestro-agent-sdk";
import { z } from "zod";
import { claudeRegistry } from "#agents/claude-registry";
import { codexRegistry } from "#agents/codex-registry";
import type { AgentRegistry } from "#agents/contracts";
import { maestroRegistry } from "#agents/maestro-registry";
import { ACTIVE_QUERY_STALE_MS, resolveDefaultModel, USERS_LOG_DIR } from "#platform/config";
import { errMsg } from "#platform/error";
import { readJsonFile } from "#platform/jsonl";
import type { AgentKind, QueryState } from "#types";
import { connectStdio, mcpOk, parseUserIdArg } from "./mcp-helpers";

const args = process.argv.slice(2);
const scopedUserId = parseUserIdArg(args);

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

function spawnCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

function resultOk(agent: string, model: string, latency: number, detail: string) {
  return { agent, model, ok: true, latency, detail };
}

function resultFail(agent: string, model: string, latency: number, error: string) {
  let category = "unknown";
  const e = error.toLowerCase();
  if (
    e.includes("auth") ||
    e.includes("key") ||
    e.includes("credential") ||
    e.includes("unauthorized")
  )
    category = "auth_error";
  else if (
    e.includes("rate") ||
    e.includes("limit") ||
    e.includes("busy") ||
    e.includes("overloaded")
  )
    category = "rate_limit";
  else if (
    e.includes("network") ||
    e.includes("refused") ||
    e.includes("dns") ||
    e.includes("timeout")
  )
    category = "network_error";
  return { agent, model, ok: false, latency, error, category };
}

// ────────────────────────────────────────────────────────
// Per-agent checkers
// ────────────────────────────────────────────────────────

async function checkClaude(model: string, timeoutMs: number) {
  const start = performance.now();
  try {
    const args = ["-p", "say OK", "--model", model, "--max-turns", "1", "--output-format", "text"];
    const { stdout, stderr } = await spawnCapture("claude", args, timeoutMs);
    const elapsed = Math.round(performance.now() - start);
    const text = (stdout + stderr).trim().slice(0, 200);
    if (!text) return resultFail("claude", model, elapsed, "empty response");
    return resultOk("claude", model, elapsed, text);
  } catch (err) {
    return resultFail("claude", model, Math.round(performance.now() - start), errMsg(err));
  }
}

async function checkCodex(model: string, timeoutMs: number) {
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
    const { stdout, stderr } = await spawnCapture("codex", args, timeoutMs, {
      ...process.env,
      CODEX_NO_COLOR: "1",
    });
    const elapsed = Math.round(performance.now() - start);
    const combined = (stdout + stderr).trim();
    const match = combined.match(/\ncodex\s*\n(.+?)(?:\n(?:tokens|session|user|$))/);
    const detail = match ? match[1].trim().slice(0, 200) : "OK";
    return resultOk("codex", model, elapsed, detail);
  } catch (err) {
    return resultFail("codex", model, Math.round(performance.now() - start), errMsg(err));
  }
}

async function checkMaestro(model: string, timeoutMs: number) {
  const start = performance.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = (maestroProvider as any)({
      model,
      prompt: "say OK",
      cwd: process.cwd(),
      maxTurns: 1,
    });
    const deadline = Date.now() + timeoutMs;
    let text = "";
    for await (const event of gen) {
      if (Date.now() > deadline) {
        return resultFail("maestro", model, Math.round(performance.now() - start), "timeout");
      }
      if (event.type === "text" && (event as any).content) {
        text = (event as any).content.slice(0, 200);
      }
      if (event.type === "error") {
        return resultFail(
          "maestro",
          model,
          Math.round(performance.now() - start),
          (event as any).error || "unknown error",
        );
      }
    }
    const elapsed = Math.round(performance.now() - start);
    return resultOk("maestro", model, elapsed, text || "(empty response)");
  } catch (err) {
    return resultFail("maestro", model, Math.round(performance.now() - start), errMsg(err));
  }
}

// ────────────────────────────────────────────────────────
// Registry helpers
// ────────────────────────────────────────────────────────

function getDefaultModel(registry: AgentRegistry): string {
  return resolveDefaultModel(registry.kind, registry.defaultModel);
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

type CheckerFn = (m: string, t: number) => Promise<CheckResult>;

const AGENTS: { kind: AgentKind; label: string; registry: AgentRegistry; checker: CheckerFn }[] = [
  { kind: "claude", label: "claude", registry: claudeRegistry, checker: checkClaude },
  { kind: "codex", label: "codex", registry: codexRegistry, checker: checkCodex },
  { kind: "maestro", label: "maestro", registry: maestroRegistry, checker: checkMaestro },
];

// ────────────────────────────────────────────────────────
// MCP Server
// ────────────────────────────────────────────────────────

const server = new McpServer({ name: "agent-health", version: "1.0.0" });

server.tool(
  "check_agent",
  "실제 API 호출로 특정 agent+model 조합이 정상 동작하는지 체크합니다. " +
    "API key 에러, rate limit, network error 등을 감지하여 결과를 리포트합니다.",
  {
    agent: z.enum(["claude", "codex", "maestro"]).describe("체크할 agent"),
    model: z.string().optional().describe("체크할 모델 (없으면 agent별 default 사용)"),
    timeoutMs: z.number().default(30000).describe("타임아웃 (ms), 기본 30초"),
  },
  async ({ agent, model, timeoutMs }) => {
    const entry = AGENTS.find((a) => a.kind === agent);
    if (!entry) return mcpOk(`❌ Unknown agent: ${agent}`);
    const m = model || getDefaultModel(entry.registry);
    const result = await entry.checker(m, timeoutMs);
    if (result.ok) {
      return mcpOk(
        `✅ OK  ${result.agent} / ${result.model}\n   latency: ${result.latency}ms\n   detail: ${result.detail}`,
      );
    }
    return mcpOk(
      `❌ FAIL  ${result.agent} / ${result.model}  [${result.category}]\n   latency: ${result.latency}ms\n   error: ${result.error}`,
    );
  },
);

server.tool(
  "check_all",
  "모든 agent (claude, codex, maestro)를 기본 모델로 동시에 체크합니다. " +
    "각 agent의 API 연결 상태를 한 번에 확인할 수 있습니다.",
  {
    timeoutMs: z.number().default(30000).describe("agent별 타임아웃 (ms), 기본 30초"),
  },
  async ({ timeoutMs }) => {
    const results = await Promise.all(
      AGENTS.map(async (entry) => {
        const model = getDefaultModel(entry.registry);
        return entry.checker(model, timeoutMs);
      }),
    );
    const lines = results.map((r) => {
      if (r.ok)
        return `✅ ${r.agent.padEnd(8)} / ${r.model.padEnd(14)} ${r.latency}ms  ${r.detail}`;
      return `❌ ${r.agent.padEnd(8)} / ${r.model.padEnd(14)} ${r.latency}ms  [${r.category}] ${r.error}`;
    });
    const allOk = results.every((r) => r.ok);
    const summary = allOk ? "🎉 All agents healthy" : "⚠️  Some agents failed";
    return mcpOk(
      `Agent/Model Health Check\n━━━━━━━━━━━━━━━━━━━━━\n${lines.join("\n")}\n\n${summary}`,
    );
  },
);

server.tool(
  "list_active_queries",
  "현재 사용자 범위에서 실행 중인 토픽 쿼리 목록을 조회합니다. topicName, 시작 시간, 경과 시간, 작업 내용(앞 100자)을 반환합니다.",
  {},
  async () => {
    const now = Date.now();
    const entries: {
      topicName: string;
      since: string;
      elapsedSec: number;
      task?: string;
    }[] = [];

    if (!scopedUserId) return mcpOk("실행 중인 쿼리 조회 불가 (user context 없음)");

    const stateDir = join(USERS_LOG_DIR, scopedUserId, "active-queries");
    if (!existsSync(stateDir)) return mcpOk("실행 중인 쿼리 없음");

    let files: string[];
    try {
      files = readdirSync(stateDir);
    } catch {
      return mcpOk("실행 중인 쿼리 없음");
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(stateDir, file);
      const state = readJsonFile<QueryState>(filePath);
      if (!state) continue;
      const sinceMs = new Date(state.since).getTime();
      if (now - sinceMs > ACTIVE_QUERY_STALE_MS) continue;

      const base = file.slice(0, -5); // remove .json
      const topicName = state.topicName ?? base;

      entries.push({
        topicName,
        since: state.since,
        elapsedSec: Math.round((now - sinceMs) / 1000),
        task: state.task,
      });
    }

    if (entries.length === 0) return mcpOk("실행 중인 쿼리 없음");

    const lines = entries.map((e) => {
      const task = e.task ? `  "${e.task}"` : "";
      return `• ${e.topicName} | ${e.elapsedSec}s 경과${task}`;
    });
    return mcpOk(`실행 중인 쿼리 (${entries.length}개)\n${lines.join("\n")}`);
  },
);

await connectStdio(server);
