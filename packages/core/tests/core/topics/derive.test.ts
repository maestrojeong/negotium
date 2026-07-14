import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { maestroSessionsDir } from "maestro-agent-sdk";
import { getRegistry } from "#agents/registry";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { deleteTopic, getTopicSessionId, upsertTopic } from "#storage/api-topics";
import {
  appendConversationEventStrict,
  getConversationPath,
  readConversation,
} from "#storage/conversations";
import { createDerivedTopic } from "#topics/derive";

describe("createDerivedTopic", () => {
  test("fork synthesizes a provider rollout when the source has no native session id", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `derive-source-${randomUUID()}`;
    const childTitle = `derive-child-${randomUUID()}`;
    const userId = `derive-user-${randomUUID()}`;
    const now = new Date().toISOString();
    let childId: string | undefined;
    let childSessionId: string | null = null;

    upsertTopic({
      id: sourceTopicId,
      title: sourceTitle,
      kind: "agent",
      agent: "maestro",
      defaultModel: "deepseek-pro",
      defaultEffort: "medium",
      participants: [{ userId, role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
      aiMode: "always",
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "user_message",
      content: "remember the fallback context",
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "result",
      content: "fallback context remembered",
      stopReason: "end_turn",
    });

    try {
      expect(getTopicSessionId(sourceTopicId)).toBeNull();
      const child = await createDerivedTopic(sourceTopicId, userId, true, { name: childTitle });
      expect(child).not.toBeNull();
      if (!child) return;
      childId = child.id;
      childSessionId = getTopicSessionId(child.id);
      expect(childSessionId).toBeTruthy();

      const childEntries = readConversation(userId, childTitle);
      expect(
        childEntries.some(
          (entry) =>
            entry.event.type === "user_message" &&
            entry.event.content === "remember the fallback context",
        ),
      ).toBe(true);

      const rolloutPath = join(maestroSessionsDir(), `${childSessionId}.jsonl`);
      expect(existsSync(rolloutPath)).toBe(true);
      expect(readFileSync(rolloutPath, "utf8")).toContain("fallback context remembered");
    } finally {
      if (childSessionId && childId) {
        await getRegistry("maestro").cleanupRollouts({
          cwd: resolveTopicWorkspaceDir(childId),
          sessionIds: [childSessionId],
        });
      }
      if (childId) {
        deleteTopic(childId);
        rmSync(resolveTopicWorkspaceDir(childId), { recursive: true, force: true });
      }
      deleteTopic(sourceTopicId);
      rmSync(getConversationPath(userId, sourceTitle), { force: true });
      rmSync(getConversationPath(userId, childTitle), { force: true });
    }
  });
});
