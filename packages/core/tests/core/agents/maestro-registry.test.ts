import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  deleteMaestroSession,
  loadMaestroSessionMeta,
  loadRawMaestroSession,
  maestroActiveSessionPath,
  maestroSessionPath,
} from "maestro-agent-sdk";
import { resolveSessionFileMissing } from "#agents/index";
import { maestroRegistry, maestroRegistryOperations } from "#agents/maestro-registry";
import { WORKSPACE_DIR } from "#platform/config";

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
  test("forks the native Maestro session at its full raw history", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    const cwd = mkdtempSync(join(WORKSPACE_DIR, "test-maestro-registry-fork-"));
    const now = new Date().toISOString();
    const parent = maestroRegistryOperations.writeRollout({
      cwd,
      entries: [
        {
          ts: now,
          agent: "maestro",
          event: { type: "user_message", content: "cacheable question" },
        },
        {
          ts: now,
          agent: "maestro",
          event: { type: "result", content: "cacheable answer", stopReason: "end_turn" },
        },
      ],
    });
    let forkSessionId: string | undefined;

    try {
      const fork = await maestroRegistryOperations.forkSession({
        parentSessionId: parent.sessionId,
        cwd,
        userId: "fork-user",
        topicName: "unused-by-native-fork",
      });
      forkSessionId = fork.forkId;

      expect(loadRawMaestroSession(fork.forkId)).toEqual(loadRawMaestroSession(parent.sessionId));
      expect(loadMaestroSessionMeta(fork.forkId)?.parentSessionId).toBe(parent.sessionId);
      expect(loadMaestroSessionMeta(fork.forkId)?.userId).toBe("fork-user");
      expect(fork.rolloutPath).toBe(maestroSessionPath(fork.forkId));
    } finally {
      deleteMaestroSession(parent.sessionId);
      if (forkSessionId) deleteMaestroSession(forkSessionId);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

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
