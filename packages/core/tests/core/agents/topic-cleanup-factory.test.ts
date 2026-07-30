import { describe, expect, test } from "bun:test";
import {
  createTopicLogMaintenance,
  type TopicConversationEntry,
  type TopicLogMaintenanceHost,
} from "#agents/topic-cleanup";

function sessionEntry(agent: "claude" | "codex", sessionId: string): TopicConversationEntry {
  return {
    ts: "2026-01-01T00:00:00.000Z",
    agent,
    event: { type: "session", sessionId },
  };
}

describe("createTopicLogMaintenance", () => {
  test("uses only the injected rollout cleanup and conversation readers", async () => {
    const cleanupCalls: Array<{ agent: string; cwd: string; sessionIds: string[] }> = [];
    const warnings: string[] = [];
    const entries = [sessionEntry("claude", "session-a"), sessionEntry("claude", "session-a")];
    const host: TopicLogMaintenanceHost = {
      agents: ["claude", "codex"],
      readActiveConversation: () => [],
      readRawConversation: () => entries,
      activeConversationPath: () => "/tmp/not-used.active.jsonl",
      rawConversationPath: () => "/tmp/not-used.jsonl",
      async cleanupRollouts(agent, cwd, sessionIds) {
        cleanupCalls.push({ agent, cwd, sessionIds });
      },
      warn: (_context, message) => warnings.push(message),
    };

    const maintenance = createTopicLogMaintenance(host);
    const cleaned = await maintenance.cleanupTopicRollouts({
      userId: "user",
      topicName: "topic",
      cwd: "/workspace",
      extraSessions: [{ agent: "codex", sessionId: "session-b" }],
    });

    expect(cleaned).toBe(true);
    expect(cleanupCalls).toEqual([
      { agent: "claude", cwd: "/workspace", sessionIds: ["session-a"] },
      { agent: "codex", cwd: "/workspace", sessionIds: ["session-b"] },
    ]);
    expect(warnings).toEqual([]);
  });

  test("keeps factory instances isolated", async () => {
    const calls = [0, 0];
    const createHost = (index: number): TopicLogMaintenanceHost => ({
      agents: ["claude"],
      readActiveConversation: () => [],
      readRawConversation: () => [sessionEntry("claude", `session-${index}`)],
      activeConversationPath: () => "/tmp/not-used.active.jsonl",
      rawConversationPath: () => "/tmp/not-used.jsonl",
      cleanupRollouts: async () => {
        calls[index] += 1;
      },
      warn: () => {},
    });

    await createTopicLogMaintenance(createHost(0)).cleanupTopicRollouts({
      userId: "user",
      topicName: "first",
      cwd: "/workspace",
    });

    expect(calls).toEqual([1, 0]);
  });
});
