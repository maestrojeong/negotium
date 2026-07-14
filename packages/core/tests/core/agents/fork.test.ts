import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupAgentFork, forkAgentSession } from "#agents/fork";
import { WORKSPACE_DIR } from "#platform/config";
import { appendConversationEventStrict, getConversationPath } from "#storage/conversations";

describe("forkAgentSession", () => {
  test("Maestro forks are seeded from Negotium's unified conversation log", async () => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    const cwd = mkdtempSync(join(WORKSPACE_DIR, "test-maestro-fork-"));
    const userId = `maestro-fork-${randomUUID()}`;
    const topicName = `topic-${randomUUID()}`;
    const conversationPath = getConversationPath(userId, topicName);
    let handle: Awaited<ReturnType<typeof forkAgentSession>> | undefined;

    try {
      appendConversationEventStrict(userId, topicName, "maestro", {
        type: "user_message",
        content: "what is the launch code?",
      });
      appendConversationEventStrict(userId, topicName, "maestro", {
        type: "result",
        content: "the launch code is violet",
        stopReason: "end_turn",
      });

      handle = await forkAgentSession({
        agent: "maestro",
        parentSessionId: randomUUID(),
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
      rmSync(conversationPath, { force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
