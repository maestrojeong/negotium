import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePersonalGeneral,
  getAllMessagesForTopic,
  getTopic,
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

      const general = getTopicByNameForUser("General", userId, { scope: "all" });
      expect(general?.kind).toBe("manager");
      expect(dispatchedTopicId).toBe(general?.id);
      expect(getTopicByNameForUser(`tg-${DM}`, userId, { scope: "all" })).toBeNull();
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
      const dmGeneral = getTopicByNameForUser("General", userId, {
        surface: "telegram",
        surfaceScope: null,
      })!;
      const dmReply: MessageDto = {
        id: randomUUID(),
        topicId: dmGeneral.id,
        authorId: "ai",
        text: "DM answer",
        queryId: "telegram-query-1",
        createdAt: new Date().toISOString(),
      };
      runtimeBus().broadcastMessage(dmGeneral.id, dmReply);
      await waitFor(() => fake.callsFor(DM).some((call) => call.text.includes("DM answer")));
      expect(fake.callsFor(FORUM).some((call) => call.text.includes("DM answer"))).toBe(false);

      fake.calls = [];
      fake.emit({
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Negotium Lab" },
        from: { id: OWNER },
        text: "Group turn",
      });
      const groupGeneral = getTopicByNameForUser("General", userId, {
        surface: "telegram",
        surfaceScope: `tg:${FORUM}`,
      })!;
      const groupReply: MessageDto = {
        ...dmReply,
        id: randomUUID(),
        topicId: groupGeneral.id,
        text: "Group answer",
        queryId: "telegram-query-2",
      };
      runtimeBus().broadcastMessage(groupGeneral.id, groupReply);
      await waitFor(() => fake.callsFor(FORUM).some((call) => call.text.includes("Group answer")));
      expect(fake.callsFor(DM).some((call) => call.text.includes("Group answer"))).toBe(false);

      fake.calls = [];
      runtimeBus().broadcastMessage(groupGeneral.id, {
        ...groupReply,
        id: randomUUID(),
        text: "Terminal answer",
        queryId: "terminal-query",
      });
      await waitFor(() =>
        fake.callsFor(FORUM).some((call) => call.text.includes("Terminal answer")),
      );
      expect(fake.callsFor(DM).some((call) => call.text.includes("Terminal answer"))).toBe(false);
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

      const general = getTopicByNameForUser("General", userId, {
        surface: "telegram",
        surfaceScope: `tg:${FORUM}`,
      })!;
      await waitFor(() => dispatchedTopicId !== undefined);
      expect(dispatchedTopicId).toBe(general.id);
      expect(getTopicByNameForUser(`tg-${FORUM}-777`, userId, { scope: "all" })).toBeNull();
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
      const general = getTopicByNameForUser("General", userId, {
        surface: "telegram",
        surfaceScope: `tg:${FORUM}`,
      })!;
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
      const topic = registerTopic({
        title,
        userId,
        surface: "telegram",
        surfaceScope: `tg:${FORUM}`,
      });
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

  test("one bot connects multiple forums with independent topic and manager namespaces", async () => {
    const fake = new FakeTelegramClient();
    const userId = `telegram-multigroup-${randomUUID()}`;
    const secondForum = FORUM - 10;
    const title = `same-name-${randomUUID()}`;
    const adapter = startTelegramAdapter({
      client: fake,
      userId,
      allowedUsers: [String(OWNER)],
      mappingDbPath: freshDb(),
      startTurn: () => null,
    });

    try {
      for (const [chatId, name] of [
        [FORUM, "Group A"],
        [secondForum, "Group B"],
      ] as const) {
        fake.emitMyChatMember({
          chat: { id: chatId, type: "supergroup", is_forum: true, title: name },
          from: { id: OWNER },
          new_chat_member: { status: "administrator", can_manage_topics: true },
        });
      }
      await waitFor(() =>
        [FORUM, secondForum].every((chatId) =>
          fake.callsFor(chatId).some((call) => call.text.includes("connected")),
        ),
      );

      for (const chatId of [FORUM, secondForum]) {
        fake.emit({
          chat: { id: chatId, type: "supergroup", is_forum: true },
          from: { id: OWNER },
          text: `/new ${title}`,
        });
      }
      await waitFor(() =>
        [FORUM, secondForum].every((chatId) =>
          fake.forumCalls.some((call) => call.chatId === chatId && call.name === title),
        ),
      );
      await waitFor(() =>
        [FORUM, secondForum].every((chatId) =>
          fake.callsFor(chatId).some((call) => call.text.includes(`creating new topic "${title}"`)),
        ),
      );

      const firstTopic = getTopicByNameForUser(title, userId, {
        surface: "telegram",
        surfaceScope: `tg:${FORUM}`,
      });
      const secondTopic = getTopicByNameForUser(title, userId, {
        surface: "telegram",
        surfaceScope: `tg:${secondForum}`,
      });
      const firstGeneral = getTopicByNameForUser("General", userId, {
        surface: "telegram",
        surfaceScope: `tg:${FORUM}`,
      });
      const secondGeneral = getTopicByNameForUser("General", userId, {
        surface: "telegram",
        surfaceScope: `tg:${secondForum}`,
      });
      expect(firstTopic?.id).toBeTruthy();
      expect(secondTopic?.id).toBeTruthy();
      expect(firstTopic?.id).not.toBe(secondTopic?.id);
      expect(firstGeneral?.id).toBeTruthy();
      expect(secondGeneral?.id).toBeTruthy();
      expect(firstGeneral?.id).not.toBe(secondGeneral?.id);

      const secondOnlyTitle = `second-only-${randomUUID()}`;
      fake.emit({
        chat: { id: secondForum, type: "supergroup", is_forum: true },
        from: { id: OWNER },
        text: `/new ${secondOnlyTitle}`,
      });
      await waitFor(() => fake.forumCalls.some((call) => call.name === secondOnlyTitle));
      await waitFor(() =>
        fake
          .callsFor(secondForum)
          .some((call) => call.text.includes(`creating new topic "${secondOnlyTitle}"`)),
      );

      fake.calls = [];
      fake.emit({
        chat: { id: FORUM, type: "supergroup", is_forum: true },
        from: { id: OWNER },
        text: `/load ${secondTopic!.id}`,
      });
      await waitFor(() =>
        fake.callsFor(FORUM).some((call) => call.text.includes("no visible topic matching")),
      );
      fake.emit({
        chat: { id: FORUM, type: "supergroup", is_forum: true },
        from: { id: OWNER },
        text: `/del ${secondTopic!.id}`,
      });
      await waitFor(() =>
        fake.callsFor(FORUM).some((call) => call.text.includes("no topic named")),
      );
      expect(getTopic(secondTopic!.id)?.id).toBe(secondTopic!.id);

      fake.calls = [];
      fake.emit({
        chat: { id: FORUM, type: "supergroup", is_forum: true },
        from: { id: OWNER },
        text: "/topics",
      });
      await waitFor(() => fake.callsFor(FORUM).length > 0);
      expect(fake.callsFor(FORUM).at(-1)?.text).not.toContain(secondOnlyTitle);
    } finally {
      adapter.stop();
    }
  });

  test("connecting another forum preserves the first forum's permanent tombstones", async () => {
    const fake = new FakeTelegramClient();
    const userId = `telegram-tombstone-groups-${randomUUID()}`;
    const secondForum = FORUM - 20;
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
        chat: { id: FORUM, type: "supergroup", is_forum: true, title: "Group A" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() => fake.callsFor(FORUM).some((call) => call.text.includes("connected")));

      fake.createMode = "reject";
      fake.createRejectError = new Error("400 Bad Request: invalid forum topic name");
      const title = `permanent-${randomUUID()}`;
      const topic = registerTopic({
        title,
        userId,
        surface: "telegram",
        surfaceScope: `tg:${FORUM}`,
      });
      await waitFor(() => fake.forumCalls.filter((call) => call.name === title).length === 1);

      fake.createMode = "auto";
      fake.emitMyChatMember({
        chat: { id: secondForum, type: "supergroup", is_forum: true, title: "Group B" },
        from: { id: OWNER },
        new_chat_member: { status: "administrator", can_manage_topics: true },
      });
      await waitFor(() =>
        fake.callsFor(secondForum).some((call) => call.text.includes("connected")),
      );

      runtimeBus().broadcastMessage(topic.id, {
        id: randomUUID(),
        topicId: topic.id,
        authorId: "ai",
        text: "still fallback",
        createdAt: new Date().toISOString(),
      } as MessageDto);
      await waitFor(() =>
        fake.callsFor(FORUM).some((call) => call.text === `[${title}] still fallback`),
      );
      expect(fake.forumCalls.filter((call) => call.name === title)).toHaveLength(1);

      const stored = openMappingStore(dbPath);
      expect(stored.loadTombstones().some((entry) => entry.topicId === topic.id)).toBe(true);
      stored.close();
    } finally {
      adapter.stop();
    }
  });

  test("legacy scope migration is idempotent and quarantines ambiguous or foreign mappings", () => {
    const userId = `telegram-migration-${randomUUID()}`;
    const firstForum = FORUM - 30;
    const secondForum = FORUM - 31;
    const uniqueDbPath = freshDb();
    const unique = registerTopic({
      title: `legacy-unique-${randomUUID()}`,
      userId,
      surface: "telegram",
    });
    const uniqueSeed = openMappingStore(uniqueDbPath);
    uniqueSeed.saveForumChatId(firstForum);
    uniqueSeed.save({ chatId: firstForum, threadId: 401, topicId: unique.id });
    uniqueSeed.close();

    const first = startTelegramAdapter({
      client: new FakeTelegramClient(),
      userId,
      mappingDbPath: uniqueDbPath,
      startTurn: () => null,
    });
    expect(getTopic(unique.id)?.surfaceScope).toBe(`tg:${firstForum}`);
    first.stop();
    const second = startTelegramAdapter({
      client: new FakeTelegramClient(),
      userId,
      mappingDbPath: uniqueDbPath,
      startTurn: () => null,
    });
    expect(getTopic(unique.id)?.surfaceScope).toBe(`tg:${firstForum}`);
    second.stop();

    const ambiguousDbPath = freshDb();
    const ambiguous = registerTopic({
      title: `legacy-ambiguous-${randomUUID()}`,
      userId,
      surface: "telegram",
    });
    const foreign = registerTopic({
      title: `legacy-foreign-${randomUUID()}`,
      userId: `${userId}-foreign`,
      surface: "terminal",
    });
    const terminalGeneral = ensurePersonalGeneral(userId, "terminal");
    const seed = openMappingStore(ambiguousDbPath);
    seed.saveGroup({ chatId: firstForum });
    seed.saveGroup({ chatId: secondForum });
    seed.save({ chatId: firstForum, threadId: 501, topicId: ambiguous.id });
    seed.save({ chatId: secondForum, threadId: 502, topicId: ambiguous.id });
    seed.save({ chatId: firstForum, threadId: 503, topicId: foreign.id });
    seed.save({ chatId: firstForum, topicId: terminalGeneral.id });
    seed.close();

    const adapter = startTelegramAdapter({
      client: new FakeTelegramClient(),
      userId,
      mappingDbPath: ambiguousDbPath,
      startTurn: () => null,
    });
    expect(getTopic(ambiguous.id)?.surfaceScope).toBeNull();
    expect(getTopic(foreign.id)?.surface).toBe("terminal");
    expect(getTopic(terminalGeneral.id)?.surface).toBe("terminal");
    const stored = openMappingStore(ambiguousDbPath);
    expect(
      stored
        .load()
        .some((entry) => [ambiguous.id, foreign.id, terminalGeneral.id].includes(entry.topicId)),
    ).toBe(false);
    stored.close();
    adapter.stop();
  });

  test("bot removal preserves the old namespace and permits another forum to connect", async () => {
    const fake = new FakeTelegramClient();
    fake.createMode = "manual";
    const orphanedThreadId = fake.nextThreadId;
    const userId = `telegram-reconnect-${randomUUID()}`;
    const dbPath = freshDb();
    const title = `preserved-${randomUUID()}`;
    const topic = registerTopic({
      title,
      userId,
      surface: "telegram",
      surfaceScope: `tg:${FORUM}`,
    });
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
      expect(getTopicByNameForUser(title, userId, { scope: "all" })?.id).toBe(topic.id);
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
        false,
      );

      // Resolving the old group's in-flight request cleans up only that
      // group's orphan thread; its canonical topic never migrates into the new
      // group's independent namespace.
      fake.resolvePendingCreates();
      await waitFor(() =>
        fake.deleteCalls.some(
          (call) => call.chatId === FORUM && call.threadId === orphanedThreadId,
        ),
      );
      const stored = openMappingStore(dbPath);
      expect(
        stored.load().some((entry) => entry.chatId === nextForum && entry.topicId === topic.id),
      ).toBe(false);
      stored.close();
    } finally {
      adapter.stop();
    }
  });
});
