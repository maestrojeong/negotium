import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { maestroActiveSessionPath, maestroSessionPath } from "maestro-agent-sdk";
import { resolveSessionFileMissing } from "#agents/index";
import { maestroRegistry, maestroRegistryOperations } from "#agents/maestro-registry";

describe("maestroRegistry model policy", () => {
  test("accepts Kimi models and aliases", () => {
    for (const model of ["kimi", "kimi-pro", "kimi-k3", "kimi-code", "kimi-k2.7-code"]) {
      expect(maestroRegistry.validateModel(model)).toBe(true);
    }
  });

  test("rejects retired DeepSeek Flash aliases", () => {
    for (const model of ["deepseek", "deepseek-flash", "deepseek-v4-flash"]) {
      expect(maestroRegistry.validateModel(model)).toBe(false);
    }
    expect(maestroRegistry.validateModel("deepseek-pro")).toBe(true);
  });
});

describe("maestroRegistry session storage", () => {
  test("treats an active-only projection as resumable", async () => {
    const sessionId = randomUUID();
    const activePath = maestroActiveSessionPath(sessionId);
    mkdirSync(dirname(activePath), { recursive: true });
    writeFileSync(activePath, '{"type":"meta"}\n');

    try {
      expect(await resolveSessionFileMissing("maestro", sessionId, process.cwd())).toBe(false);
    } finally {
      rmSync(activePath, { force: true });
    }
  });

  test("cleanup removes raw, active, memory, and task session files", async () => {
    const sessionId = randomUUID();
    const rawPath = maestroSessionPath(sessionId);
    const activePath = maestroActiveSessionPath(sessionId);
    const sessionsDir = dirname(rawPath);
    const memoryPath = join(dirname(sessionsDir), "memory", `${sessionId}.json`);
    const sdkTasksDir = join(homedir(), ".maestro", "sessions");
    const tasksPath = join(sdkTasksDir, `${sessionId}.tasks.json`);
    const todosPath = join(sdkTasksDir, `${sessionId}.todos.json`);
    mkdirSync(dirname(rawPath), { recursive: true });
    mkdirSync(dirname(memoryPath), { recursive: true });
    mkdirSync(sdkTasksDir, { recursive: true });
    writeFileSync(rawPath, '{"type":"meta"}\n');
    writeFileSync(activePath, '{"type":"meta"}\n');
    writeFileSync(memoryPath, "{}\n");
    writeFileSync(tasksPath, "{}\n");
    writeFileSync(todosPath, "{}\n");

    await maestroRegistryOperations.cleanupRollouts({
      cwd: process.cwd(),
      sessionIds: [sessionId],
    });

    expect(existsSync(rawPath)).toBe(false);
    expect(existsSync(activePath)).toBe(false);
    expect(existsSync(memoryPath)).toBe(false);
    expect(existsSync(tasksPath)).toBe(false);
    expect(existsSync(todosPath)).toBe(false);
  });
});
