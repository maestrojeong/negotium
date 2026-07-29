import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maestroSessionsDir } from "maestro-agent-sdk";
import { getRegistry } from "#agents/registry";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { deleteTopicProfileDir, resolveTopicProfileDir } from "#platform/playwright/manager";
import { appendApiMessage, getAllMessagesForTopic } from "#storage/api-messages";
import { deleteApiTopicConfig, getApiTopicConfig } from "#storage/api-topic-config";
import {
  deleteTopic,
  getTopicSessionId,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import {
  appendConversationEventStrict,
  getConversationPath,
  readConversation,
} from "#storage/conversations";
import { claimRuntimeTurnLease, releaseRuntimeTurnLease } from "#storage/runtime-leases";
import { beginRuntimeTopicMaintenance } from "#storage/runtime-topic-state";
import { createDerivedTopic, TopicDeriveBusyError, TopicForkCompactionError } from "#topics/derive";

describe("createDerivedTopic", () => {
  test("uses one capture boundary for canonical and visible fork history", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `boundary-source-${randomUUID()}`;
    const childTitle = `boundary-child-${randomUUID()}`;
    const userId = `boundary-user-${randomUUID()}`;
    const now = new Date().toISOString();
    let childId: string | undefined;
    let childSessionId: string | null = null;

    upsertTopic({
      id: sourceTopicId,
      title: sourceTitle,
      kind: "agent",
      defaultModel: "",
      defaultEffort: "medium",
      aiMode: "always",
      participants: [{ userId, role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
    });
    appendApiMessage({
      id: randomUUID(),
      topicId: sourceTopicId,
      authorId: userId,
      text: "visible before boundary",
      createdAt: now,
    });
    appendApiMessage({
      id: randomUUID(),
      topicId: sourceTopicId,
      authorId: userId,
      text: "visible after boundary",
      createdAt: "9999-12-31T23:59:59.999Z",
    });
    appendConversationEventStrict(userId, sourceTitle, "codex", {
      type: "user_message",
      content: "canonical before boundary",
    });
    writeFileSync(
      getConversationPath(userId, sourceTitle),
      `${JSON.stringify({
        ts: "9999-12-31T23:59:59.999Z",
        agent: "codex",
        event: { type: "result", content: "canonical after boundary", stopReason: "end_turn" },
      })}\n`,
      { flag: "a" },
    );

    try {
      const child = await createDerivedTopic(sourceTopicId, userId, true, { name: childTitle });
      expect(child).not.toBeNull();
      if (!child) return;
      childId = child.id;
      childSessionId = getTopicSessionId(child.id);
      expect(getAllMessagesForTopic(child.id).map((message) => message.text)).toEqual([
        "visible before boundary",
      ]);
      const childEntries = readConversation(userId, childTitle);
      expect(childEntries[0]).toMatchObject({
        event: { type: "user_message", content: "canonical before boundary" },
      });
      expect(JSON.stringify(childEntries)).not.toContain("canonical after boundary");
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

  test("allows regular fork and spawn while the source is under maintenance", async () => {
    const sourceTopicId = randomUUID();
    const userId = `busy-spawn-user-${randomUUID()}`;
    const now = new Date().toISOString();
    const childIds: string[] = [];
    upsertTopic({
      id: sourceTopicId,
      title: `busy-spawn-source-${randomUUID()}`,
      kind: "agent",
      defaultModel: "",
      defaultEffort: "medium",
      aiMode: "always",
      participants: [{ userId, role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
    });
    const maintenance = beginRuntimeTopicMaintenance(sourceTopicId, { heartbeatMs: 60_000 });
    expect(maintenance).not.toBeNull();
    try {
      for (const copyHistory of [true, false]) {
        const child = await createDerivedTopic(sourceTopicId, userId, copyHistory, {
          name: `busy-${copyHistory ? "fork" : "spawn"}-child-${randomUUID()}`,
        });
        expect(child).not.toBeNull();
        if (child) childIds.push(child.id);
      }
    } finally {
      maintenance?.finish();
      for (const childId of childIds) {
        deleteTopic(childId);
        rmSync(resolveTopicWorkspaceDir(childId), { recursive: true, force: true });
      }
      deleteTopic(sourceTopicId);
    }
  });

  test("rejects subagent creation while the parent is under maintenance", async () => {
    const sourceTopicId = randomUUID();
    const userId = `maintenance-user-${randomUUID()}`;
    const now = new Date().toISOString();
    upsertTopic({
      id: sourceTopicId,
      title: `maintenance-source-${randomUUID()}`,
      kind: "agent",
      agent: "maestro",
      defaultModel: "deepseek-pro",
      defaultEffort: "medium",
      aiMode: "always",
      participants: [{ userId, role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
    });
    const maintenance = beginRuntimeTopicMaintenance(sourceTopicId, { heartbeatMs: 60_000 });
    expect(maintenance).not.toBeNull();
    try {
      await expect(
        createDerivedTopic(sourceTopicId, userId, false, {
          name: `blocked-child-${randomUUID()}`,
          subagent: { agent: "codex" },
        }),
      ).rejects.toBeInstanceOf(TopicDeriveBusyError);
    } finally {
      maintenance?.finish();
      deleteTopic(sourceTopicId);
    }
  });

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

  test("fork bypasses a mutable native rollout and uses the captured canonical snapshot", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `active-native-source-${randomUUID()}`;
    const childTitle = `active-native-child-${randomUUID()}`;
    const userId = `active-native-user-${randomUUID()}`;
    const now = new Date().toISOString();
    const sourceCwd = resolveTopicWorkspaceDir(sourceTopicId);
    let childId: string | undefined;
    let childSessionId: string | null = null;
    let sourceSessionId: string | undefined;

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
    mkdirSync(sourceCwd, { recursive: true });
    const nativeRollout = getRegistry("maestro").writeRollout({
      cwd: sourceCwd,
      entries: [
        {
          ts: now,
          agent: "maestro",
          event: { type: "user_message", content: "native-only request" },
        },
        {
          ts: now,
          agent: "maestro",
          event: { type: "result", content: "native-only response", stopReason: "end_turn" },
        },
      ],
      model: "deepseek-pro",
      effort: "medium",
    });
    sourceSessionId = nativeRollout.sessionId;
    setTopicSessionId(sourceTopicId, sourceSessionId, {
      reason: "active-native-test",
      agent: "maestro",
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "user_message",
      content: "canonical snapshot request",
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "result",
      content: "canonical snapshot response",
      stopReason: "end_turn",
    });
    try {
      const child = await createDerivedTopic(sourceTopicId, userId, true, { name: childTitle });
      expect(child).not.toBeNull();
      if (!child) return;
      childId = child.id;
      childSessionId = getTopicSessionId(child.id);
      const childRollout = readFileSync(
        join(maestroSessionsDir(), `${childSessionId}.jsonl`),
        "utf8",
      );
      expect(childRollout).toContain("canonical snapshot response");
      expect(childRollout).not.toContain("native-only response");
    } finally {
      if (sourceSessionId) {
        await getRegistry("maestro").cleanupRollouts({
          cwd: sourceCwd,
          sessionIds: [sourceSessionId],
        });
      }
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
      rmSync(sourceCwd, { recursive: true, force: true });
      rmSync(getConversationPath(userId, sourceTitle), { force: true });
      rmSync(getConversationPath(userId, childTitle), { force: true });
    }
  });

  test("compacts a large fork rollout while preserving visible child history", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `compact-source-${randomUUID()}`;
    const childTitle = `compact-child-${randomUUID()}`;
    const userId = `compact-user-${randomUUID()}`;
    const now = new Date().toISOString();
    let childId: string | undefined;
    let childSessionId: string | null = null;

    upsertTopic({
      id: sourceTopicId,
      title: sourceTitle,
      kind: "agent",
      agent: "maestro",
      defaultModel: "kimi-k3",
      defaultEffort: "medium",
      participants: [{ userId, role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
      aiMode: "always",
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "user_message",
      content: `large request ${"x".repeat(100_000)}`,
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "result",
      content: "large response",
      stopReason: "end_turn",
    });
    appendApiMessage({
      id: randomUUID(),
      topicId: sourceTopicId,
      authorId: userId,
      text: "large request remains available in visible history",
      createdAt: now,
    });

    try {
      const child = await createDerivedTopic(sourceTopicId, userId, true, {
        name: childTitle,
        summarizeFork: async (request) => {
          expect(request.source).toContain("large request");
          expect(request.source).toContain("large response");
          expect(request.source).toContain("Provider conversation snapshot");
          expect(request.source).toContain("Visible conversation snapshot");
          expect(request.model).toBe("deepseek-v4-pro");
          expect(request.effort).toBe("medium");
          return "Compact fork summary with decisions and next steps.";
        },
      });
      expect(child).not.toBeNull();
      if (!child) return;
      childId = child.id;
      childSessionId = getTopicSessionId(child.id);
      expect(childSessionId).toBeTruthy();
      expect(child.defaultModel).toBe("kimi-k3");

      const childEntries = readConversation(userId, childTitle);
      expect(childEntries.map((entry) => entry.event.type)).toEqual([
        "user_message",
        "result",
        "session",
      ]);
      expect(childEntries[1]?.event).toMatchObject({
        type: "result",
        content: "Compact fork summary with decisions and next steps.",
      });
      expect(
        childEntries.some(
          (entry) =>
            entry.event.type === "user_message" && entry.event.content.includes("large request"),
        ),
      ).toBe(false);
      expect(getAllMessagesForTopic(child.id).map((message) => message.text)).toContain(
        "large request remains available in visible history",
      );

      const rolloutPath = join(maestroSessionsDir(), `${childSessionId}.jsonl`);
      expect(readFileSync(rolloutPath, "utf8")).toContain(
        "Compact fork summary with decisions and next steps.",
      );
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

  test("fork compaction uses one immutable snapshot while an active source advances", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `snapshot-source-${randomUUID()}`;
    const childTitle = `snapshot-child-${randomUUID()}`;
    const userId = `snapshot-user-${randomUUID()}`;
    const queryId = `snapshot-query-${randomUUID()}`;
    const leaseOwner = `snapshot-owner-${randomUUID()}`;
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
      content: `snapshot request ${"x".repeat(100_000)}`,
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "result",
      content: "snapshot response",
      stopReason: "end_turn",
    });
    appendApiMessage({
      id: randomUUID(),
      topicId: sourceTopicId,
      authorId: userId,
      text: "visible before snapshot",
      createdAt: now,
    });
    expect(
      claimRuntimeTurnLease({
        topicId: sourceTopicId,
        queryId,
        origin: "user",
        ownerId: leaseOwner,
      }),
    ).toBe(true);

    try {
      const child = await createDerivedTopic(sourceTopicId, userId, true, {
        name: childTitle,
        summarizeFork: async (request) => {
          expect(request.source).toContain("visible before snapshot");
          appendConversationEventStrict(userId, sourceTitle, "maestro", {
            type: "user_message",
            content: "canonical after snapshot",
          });
          appendApiMessage({
            id: randomUUID(),
            topicId: sourceTopicId,
            authorId: userId,
            text: "visible after snapshot",
            createdAt: new Date().toISOString(),
          });
          return "Immutable active-fork summary.";
        },
      });
      expect(child).not.toBeNull();
      if (!child) return;
      childId = child.id;
      childSessionId = getTopicSessionId(child.id);

      expect(getAllMessagesForTopic(child.id).map((message) => message.text)).toEqual([
        "visible before snapshot",
      ]);
      expect(readConversation(userId, childTitle)).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ type: "user_message" }),
        }),
        expect.objectContaining({
          event: {
            type: "result",
            content: "Immutable active-fork summary.",
            stopReason: "end_turn",
          },
        }),
        expect.objectContaining({
          event: { type: "session", sessionId: childSessionId },
        }),
      ]);
    } finally {
      releaseRuntimeTurnLease(sourceTopicId, queryId, leaseOwner);
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

  test("does not silently fall back when required fork compaction fails", async () => {
    const sourceTopicId = randomUUID();
    const sourceTitle = `compact-failure-source-${randomUUID()}`;
    const childTitle = `compact-failure-child-${randomUUID()}`;
    const userId = `compact-failure-user-${randomUUID()}`;
    const now = new Date().toISOString();

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
      content: `must compact ${"x".repeat(100_000)}`,
    });
    appendConversationEventStrict(userId, sourceTitle, "maestro", {
      type: "result",
      content: "large response",
      stopReason: "end_turn",
    });

    try {
      await expect(
        createDerivedTopic(sourceTopicId, userId, true, {
          name: childTitle,
          summarizeFork: async () => {
            throw new Error("summarizer unavailable");
          },
        }),
      ).rejects.toBeInstanceOf(TopicForkCompactionError);
      expect(readConversation(userId, childTitle)).toEqual([]);
    } finally {
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
