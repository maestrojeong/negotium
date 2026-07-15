import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAllMessagesForTopic,
  getTopicByNameForUser,
  type MessageDto,
  registerTopic,
  runtimeBus,
} from "@negotium/core";
import { openMappingStore, startTelegramAdapter } from "@/index";
import { FakeTelegramClient, waitFor } from "./fake-client";

const OWNER = 771_001;
const DM = OWNER;
const FORUM = -1_007_771_001;

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), "negotium-telegram-onboarding-")), "mapping.db");
}

describe("Clawgram-style onboarding", () => {
  test("a private DM opens the personal General manager and shows the English guide", async () => {
    const fake = new FakeTelegramClient();
    const userId = `telegram-general-${randomUUID()}`;
    let dispatchedTopicId: string | undefined;
    const adapter = startTelegramAdapter({
      client: fake,
      userId,
      allowedUsers: [String(OWNER)],
      mappingDbPath: freshDb(),
      startTurn(params) {
        dispatchedTopicId = params.topic.id;
        return null;
      },
    });

    try {
      fake.emit({
        chat: { id: DM, type: "private" },
        from: { id: OWNER },
        text: "Please create a research topic",
      });
      await waitFor(() =>
        fake.callsFor(DM).some((call) => call.text.includes("Welcome to Negotium")),
      );

      const general = getTopicByNameForUser("General", userId);
      expect(general?.kind).toBe("manager");
      expect(dispatchedTopicId).toBe(general?.id);
      expect(getTopicByNameForUser(`tg-${DM}`, userId)).toBeNull();
      expect(
        getAllMessagesForTopic(general!.id).some(
          (message) => message.text === "Please create a research topic",
        ),
      ).toBe(true);
      expect(fake.callsFor(DM).at(0)?.text).toContain("no /connect command is needed");
      expect(fake.callsFor(DM).at(0)?.text).toContain("@negotium_test_bot");
    } finally {
      adapter.stop();
    }
  });

  test("promotion auto-connects a forum and query replies return only to their origin", async () => {
    const fake = new FakeTelegramClient();
    const userId = `telegram-routing-${randomUUID()}`;
    const dbPath = freshDb();
    let queryCounter = 0;
    const adapter = startTelegramAdapter({
      client: fake,
      userId,
      allowedUsers: [String(OWNER)],
      mappingDbPath: dbPath,
      startTurn(params) {
        const queryId = `telegram-query-${++queryCounter}`;
        params.onDispatched?.(queryId);
        return queryId;
      },
    });

    try {
      fake.emitMyChatMember({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Negotium Lab" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() => fake.callsFor(FORUM).some((call) => call.text.includes("connected")));

      const stored = openMappingStore(dbPath);
      expect(stored.loadForumChatId()).toBe(FORUM);
      stored.close();

      fake.calls = [];
      fake.emit({ chat: { id: DM, type: "private" }, from: { id: OWNER }, text: "DM turn" });
      const general = getTopicByNameForUser("General", userId)!;
      const dmReply: MessageDto = {
        id: randomUUID(),
        topicId: general.id,
        authorId: "ai",
        text: "DM answer",
        queryId: "telegram-query-1",
        createdAt: new Date().toISOString(),
      };
      runtimeBus().broadcastMessage(general.id, dmReply);
      await waitFor(() => fake.callsFor(DM).some((call) => call.text.includes("DM answer")));
      expect(fake.callsFor(FORUM).some((call) => call.text.includes("DM answer"))).toBe(false);

      fake.calls = [];
      fake.emit({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Negotium Lab" },
        from: { id: OWNER },
        text: "Group turn",
      });
      const groupReply: MessageDto = {
        ...dmReply,
        id: randomUUID(),
        text: "Group answer",
        queryId: "telegram-query-2",
      };
      runtimeBus().broadcastMessage(general.id, groupReply);
      await waitFor(() => fake.callsFor(FORUM).some((call) => call.text.includes("Group answer")));
      expect(fake.callsFor(DM).some((call) => call.text.includes("Group answer"))).toBe(false);

      fake.calls = [];
      runtimeBus().broadcastMessage(general.id, {
        ...dmReply,
        id: randomUUID(),
        text: "Terminal answer",
        queryId: "terminal-query",
      });
      await waitFor(
        () =>
          fake.callsFor(DM).some((call) => call.text.includes("Terminal answer")) &&
          fake.callsFor(FORUM).some((call) => call.text.includes("Terminal answer")),
      );
    } finally {
      adapter.stop();
    }
  });

  test("a generic thread shown in forum General stays bound to personal General", async () => {
    const fake = new FakeTelegramClient();
    const userId = `telegram-generic-general-${randomUUID()}`;
    let dispatchedTopicId: string | undefined;
    const adapter = startTelegramAdapter({
      client: fake,
      userId,
      allowedUsers: [String(OWNER)],
      mappingDbPath: freshDb(),
      startTurn(params) {
        dispatchedTopicId = params.topic.id;
        return "generic-general-query";
      },
    });

    try {
      fake.emitMyChatMember({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Negotium Lab" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() => fake.callsFor(FORUM).some((call) => call.text.includes("connected")));
      fake.calls = [];

      fake.emit({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Negotium Lab" },
        from: { id: OWNER },
        text: "reply inside a generic General thread",
        message_thread_id: 777,
      });

      const general = getTopicByNameForUser("General", userId)!;
      await waitFor(() => dispatchedTopicId !== undefined);
      expect(dispatchedTopicId).toBe(general.id);
      expect(getTopicByNameForUser(`tg-${FORUM}-777`, userId)).toBeNull();
    } finally {
      adapter.stop();
    }
  });

  test("a missed promotion is recovered from the first forum message after admin checks", async () => {
    const fake = new FakeTelegramClient();
    const userId = `telegram-fallback-${randomUUID()}`;
    fake.members.set(`${FORUM}:${fake.me.id}`, {
      status: "administrator",
      can_manage_topics: true,
    });
    fake.members.set(`${FORUM}:${OWNER}`, { status: "creator" });
    const adapter = startTelegramAdapter({
      client: fake,
      userId,
      allowedUsers: [String(OWNER)],
      mappingDbPath: freshDb(),
      startTurn: () => null,
    });

    try {
      fake.emit({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Recovered Lab" },
        from: { id: OWNER },
        text: "Connect and handle this",
      });
      await waitFor(() => fake.callsFor(FORUM).some((call) => call.text.includes("connected")));
      const general = getTopicByNameForUser("General", userId)!;
      await waitFor(() =>
        getAllMessagesForTopic(general.id).some(
          (message) => message.text === "Connect and handle this",
        ),
      );
    } finally {
      adapter.stop();
    }
  });

  test("granting Manage Topics retries topics that failed during onboarding", async () => {
    const fake = new FakeTelegramClient();
    const userId = `telegram-permission-${randomUUID()}`;
    const dbPath = freshDb();
    const adapter = startTelegramAdapter({
      client: fake,
      userId,
      allowedUsers: [String(OWNER)],
      mappingDbPath: dbPath,
      startTurn: () => null,
    });

    try {
      fake.emitMyChatMember({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Permission Lab" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() => fake.callsFor(FORUM).some((call) => call.text.includes("connected")));

      fake.createMode = "reject";
      const title = `permission-retry-${randomUUID()}`;
      const topic = registerTopic({ title, userId });
      await waitFor(() => fake.forumCalls.filter((call) => call.name === title).length === 1);

      fake.createMode = "auto";
      fake.emitMyChatMember({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Permission Lab" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() => fake.forumCalls.filter((call) => call.name === title).length === 2);
      await waitFor(() => {
        const stored = openMappingStore(dbPath);
        const mapped = stored
          .load()
          .some((entry) => entry.topicId === topic.id && entry.threadId !== undefined);
        stored.close();
        return mapped;
      });
      expect(fake.callsFor(FORUM).some((call) => call.text.includes("permission confirmed"))).toBe(
        true,
      );
    } finally {
      adapter.stop();
    }
  });

  test("bot removal disconnects channel state and permits a different forum to reconnect", async () => {
    const fake = new FakeTelegramClient();
    fake.createMode = "manual";
    const orphanedThreadId = fake.nextThreadId;
    const userId = `telegram-reconnect-${randomUUID()}`;
    const dbPath = freshDb();
    const title = `preserved-${randomUUID()}`;
    const topic = registerTopic({ title, userId });
    const nextForum = FORUM - 1;
    const adapter = startTelegramAdapter({
      client: fake,
      userId,
      allowedUsers: [String(OWNER)],
      mappingDbPath: dbPath,
      startTurn: () => null,
    });

    try {
      fake.emitMyChatMember({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Old Lab" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() =>
        fake.forumCalls.some((call) => call.chatId === FORUM && call.name === title),
      );

      // The connected group's membership state is authoritative even when a
      // different group admin removed the bot.
      fake.emitMyChatMember({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Old Lab" },
        from: { id: OWNER + 99 },
        new_chat_member: { status: "kicked" },
      });
      await waitFor(() => {
        const stored = openMappingStore(dbPath);
        const disconnected = stored.loadForumChatId() === undefined;
        stored.close();
        return disconnected;
      });
      expect(getTopicByNameForUser(title, userId)?.id).toBe(topic.id);
      expect(fake.callsFor(DM).some((call) => call.text.includes("was disconnected"))).toBe(true);

      fake.createMode = "auto";
      fake.emitMyChatMember({
        chat: { id: nextForum, type: "supergroup", is_forum: true, title: "New Lab" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() => {
        const stored = openMappingStore(dbPath);
        const connected = stored.loadForumChatId() === nextForum;
        stored.close();
        return connected;
      });
      expect(fake.forumCalls.some((call) => call.chatId === nextForum && call.name === title)).toBe(
        true,
      );

      // Resolving the old group's in-flight request must clean up only its
      // orphan thread, never the new group's mapping for the same topic.
      fake.resolvePendingCreates();
      await waitFor(() =>
        fake.deleteCalls.some(
          (call) => call.chatId === FORUM && call.threadId === orphanedThreadId,
        ),
      );
      const stored = openMappingStore(dbPath);
      expect(
        stored.load().some((entry) => entry.chatId === nextForum && entry.topicId === topic.id),
      ).toBe(true);
      stored.close();
    } finally {
      adapter.stop();
    }
  });
});
