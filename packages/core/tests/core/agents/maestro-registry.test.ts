import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  deleteMaestroSession,
  loadMaestroSession,
  loadMaestroSessionMeta,
  loadRawMaestroSession,
  maestroActiveSessionPath,
  maestroSessionPath,
} from "maestro-agent-sdk";
import { cleanupAgentFork, forkAgentSession } from "#agents/fork";
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
      expect(loadMaestroSessionMeta(parent.sessionId)?.sdkVersion).toBe("0.2.0");
      expect(fork.rolloutPath).toBe(maestroSessionPath(fork.forkId));
    } finally {
      deleteMaestroSession(parent.sessionId);
      if (forkSessionId) deleteMaestroSession(forkSessionId);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects a cold fork when a compacted parent projection cannot be copied", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    const cwd = mkdtempSync(join(WORKSPACE_DIR, "test-maestro-registry-cold-fork-"));
    const parentSessionId = randomUUID();
    const rawPath = maestroSessionPath(parentSessionId);
    const activePath = maestroActiveSessionPath(parentSessionId);
    const meta = {
      _meta: {
        version: 1,
        cwd,
        createdAt: new Date().toISOString(),
        sdkVersion: "0.2.0",
      },
    };
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(
      rawPath,
      `${[
        meta,
        { _seq: 0, m: { role: "user", content: "question" } },
        { _seq: 1, m: { role: "assistant", content: "answer" } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    // The sidecar exists but has no compaction marker/summary pair, so the SDK
    // correctly declines to treat it as a reusable active projection.
    writeFileSync(activePath, '{"role":"user","content":"invalid projection"}\n');

    try {
      await expect(
        maestroRegistryOperations.forkSession({
          parentSessionId,
          cwd,
          userId: "fork-user",
          topicName: "unused-by-native-fork",
        }),
      ).rejects.toThrow("active projection could not be forked");
    } finally {
      deleteMaestroSession(parentSessionId);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("forks a compacted Maestro session with its active working view", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    const cwd = mkdtempSync(join(WORKSPACE_DIR, "test-maestro-registry-compact-fork-"));
    const parentSessionId = randomUUID();
    const rawPath = maestroSessionPath(parentSessionId);
    const activePath = maestroActiveSessionPath(parentSessionId);
    const createdAt = new Date().toISOString();
    const meta = {
      _meta: {
        version: 1,
        cwd,
        createdAt,
        sdkVersion: "0.2.0",
        userId: "parent-user",
        activeDeferredTools: ["deferred_search"],
      },
    };
    const rawMessages = Array.from({ length: 14 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `raw-${index}`,
    }));
    const rawLines = [meta, ...rawMessages.map((message, index) => ({ _seq: index, m: message }))];
    const activeLines = [
      meta,
      { _seq: 0, m: rawMessages[0] },
      { _seq: 1, m: rawMessages[1] },
      { role: "user", content: "\u0000maestro-compaction\u0000" },
      { role: "assistant", content: "summary-of-middle" },
      ...rawMessages.slice(10).map((message, index) => ({ _seq: index + 10, m: message })),
    ];
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, `${rawLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    writeFileSync(activePath, `${activeLines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    let forkHandle: Awaited<ReturnType<typeof forkAgentSession>> | undefined;

    try {
      const parentWorkingView = loadMaestroSession(parentSessionId);
      const fork = await forkAgentSession({
        agent: "maestro",
        parentSessionId,
        cwd,
        userId: "fork-user",
        topicName: "unused-by-native-fork",
      });
      forkHandle = fork;

      expect(loadRawMaestroSession(fork.forkId)).toEqual(rawMessages);
      expect(loadMaestroSession(fork.forkId)).toEqual(parentWorkingView);
      expect(existsSync(maestroActiveSessionPath(fork.forkId))).toBe(true);
      expect(loadMaestroSessionMeta(fork.forkId)?.activeDeferredTools).toEqual(["deferred_search"]);
      expect(readFileSync(maestroActiveSessionPath(fork.forkId), "utf8")).toContain(
        "summary-of-middle",
      );
      cleanupAgentFork(fork);
      forkHandle = undefined;
      expect(existsSync(fork.rolloutPath)).toBe(false);
      expect(existsSync(maestroActiveSessionPath(fork.forkId))).toBe(false);
    } finally {
      deleteMaestroSession(parentSessionId);
      if (forkHandle) cleanupAgentFork(forkHandle);
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
