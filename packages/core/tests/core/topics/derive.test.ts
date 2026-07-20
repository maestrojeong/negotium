import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maestroSessionsDir } from "maestro-agent-sdk";
import { getRegistry } from "#agents/registry";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { deleteTopicProfileDir, resolveTopicProfileDir } from "#platform/playwright/manager";
import { deleteApiTopicConfig, getApiTopicConfig } from "#storage/api-topic-config";
import { deleteTopic, getTopicSessionId, upsertTopic } from "#storage/api-topics";
import {
  appendConversationEventStrict,
  getConversationPath,
  readConversation,
} from "#storage/conversations";
import { createDerivedTopic } from "#topics/derive";

describe("createDerivedTopic", () => {
  test("inherits hidden visibility so internal topics cannot derive visible children", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `hidden-source-${randomUUID()}`;
    const childTitle = `hidden-child-${randomUUID()}`;
    const userId = `hidden-user-${randomUUID()}`;
    const now = new Date().toISOString();
    let childId: string | undefined;

    upsertTopic({
      id: sourceTopicId,
      title: sourceTitle,
      kind: "agent",
      agent: "claude",
      defaultModel: "sonnet",
      defaultEffort: "medium",
      aiMode: "always",
      participants: [{ userId, role: "owner" }],
      visibility: "hidden",
      accessMode: "shared",
      createdAt: now,
      lastMessageAt: now,
    });

    try {
      const child = await createDerivedTopic(sourceTopicId, userId, false, { name: childTitle });
      expect(child).not.toBeNull();
      childId = child?.id;
      expect(child?.visibility).toBe("hidden");
      expect(child?.accessMode).toBe("shared");
    } finally {
      if (childId) {
        deleteTopic(childId);
        rmSync(resolveTopicWorkspaceDir(childId), { recursive: true, force: true });
      }
      deleteTopic(sourceTopicId);
    }
  });

  test("fork, spawn, and subagent children share the parent browser profile", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `profile-source-${randomUUID()}`;
    const userId = `profile-user-${randomUUID()}`;
    const now = new Date().toISOString();
    const sourceProfileDir = resolveTopicProfileDir(userId, sourceTopicId);
    const children: string[] = [];

    upsertTopic({
      id: sourceTopicId,
      title: sourceTitle,
      kind: "channel",
      defaultModel: "",
      defaultEffort: "medium",
      aiMode: "mention",
      participants: [{ userId, role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
    });
    mkdirSync(join(sourceProfileDir, "Default"), { recursive: true });
    writeFileSync(join(sourceProfileDir, "Default", "Cookies"), "signed-in-cookie");
    writeFileSync(join(sourceProfileDir, "SingletonLock"), "stale-parent-lock");

    try {
      const variants: Array<{
        copyHistory: boolean;
        name: string;
        subagent?: Record<string, never>;
      }> = [
        { copyHistory: true, name: `profile-fork-${randomUUID()}` },
        { copyHistory: false, name: `profile-spawn-${randomUUID()}` },
        {
          copyHistory: false,
          name: `profile-subagent-${randomUUID()}`,
          subagent: {},
        },
      ];

      for (const variant of variants) {
        const child = await createDerivedTopic(sourceTopicId, userId, variant.copyHistory, {
          name: variant.name,
          ...(variant.subagent ? { subagent: variant.subagent } : {}),
        });
        expect(child).not.toBeNull();
        if (!child) continue;
        children.push(child.id);
        const childProfileDir = resolveTopicProfileDir(userId, child.id);
        expect(childProfileDir).toBe(sourceProfileDir);
        expect(readFileSync(join(childProfileDir, "Default", "Cookies"), "utf8")).toBe(
          "signed-in-cookie",
        );
        expect(existsSync(join(childProfileDir, "SingletonLock"))).toBe(true);
      }
    } finally {
      for (const childId of children) {
        deleteTopic(childId);
        deleteTopicProfileDir(userId, childId);
        rmSync(resolveTopicWorkspaceDir(childId), { recursive: true, force: true });
      }
      deleteTopic(sourceTopicId);
      deleteTopicProfileDir(userId, sourceTopicId);
      rmSync(getConversationPath(userId, sourceTitle), { force: true });
    }
  });

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

  test("canonicalizes Kimi aliases for subagent defaults and config", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `kimi-source-${randomUUID()}`;
    const childTitle = `kimi-child-${randomUUID()}`;
    const userId = `kimi-user-${randomUUID()}`;
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

    try {
      const child = await createDerivedTopic(sourceTopicId, userId, false, {
        name: childTitle,
        subagent: { agent: "maestro", model: "kimi-pro" },
      });
      expect(child).not.toBeNull();
      if (!child) return;
      childId = child.id;
      childSessionId = getTopicSessionId(child.id);

      expect(child.defaultModel).toBe("kimi-k3");
      expect(getApiTopicConfig(child.id)?.model).toBe("kimi-k3");
    } finally {
      if (childSessionId && childId) {
        await getRegistry("maestro").cleanupRollouts({
          cwd: resolveTopicWorkspaceDir(childId),
          sessionIds: [childSessionId],
        });
      }
      if (childId) {
        deleteApiTopicConfig(childId);
        deleteTopic(childId);
        rmSync(resolveTopicWorkspaceDir(childId), { recursive: true, force: true });
      }
      deleteTopic(sourceTopicId);
      rmSync(getConversationPath(userId, childTitle), { force: true });
    }
  });
});
