import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupAgentFork, forkAgentSession } from "#agents/fork";
import { getRegistryOperations } from "#agents/registry";
import { WORKSPACE_DIR } from "#platform/config";

describe("forkAgentSession", () => {
  test("Maestro forks clone the native provider session", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    const cwd = mkdtempSync(join(WORKSPACE_DIR, "test-maestro-fork-"));
    const userId = `maestro-fork-${randomUUID()}`;
    const topicName = `topic-${randomUUID()}`;
    const now = new Date().toISOString();
    const parent = getRegistryOperations("maestro").writeRollout({
      cwd,
      entries: [
        {
          ts: now,
          agent: "maestro",
          event: { type: "user_message", content: "what is the launch code?" },
        },
        {
          ts: now,
          agent: "maestro",
          event: {
            type: "result",
            content: "the launch code is violet",
            stopReason: "end_turn",
          },
        },
      ],
    });
    let handle: Awaited<ReturnType<typeof forkAgentSession>> | undefined;

    try {
      handle = await forkAgentSession({
        agent: "maestro",
        parentSessionId: parent.sessionId,
        cwd,
        userId,
        topicName,
      });

      expect(existsSync(handle.rolloutPath)).toBe(true);
      const rolloutText = readFileSync(handle.rolloutPath, "utf8");
      expect(rolloutText).toContain("what is the launch code?");
      expect(rolloutText).toContain("the launch code is violet");
      expect(rolloutText.trim().split("\n").length).toBeGreaterThan(1);
    } finally {
      if (handle) cleanupAgentFork(handle);
      await getRegistryOperations("maestro").cleanupRollouts({
        cwd,
        sessionIds: [parent.sessionId],
      });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
