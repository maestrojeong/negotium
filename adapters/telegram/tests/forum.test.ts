import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTopicByNameForUser,
  type MessageDto,
  registerTopic,
  runtimeBus,
  updateTopic,
} from "@negotium/core";
import type { TelegramAdapterHandle } from "@/index";
import { openMappingStore, startTelegramAdapter } from "@/index";
import { FakeTelegramClient, waitFor } from "./fake-client";

const USER = "tg-forum-tester";
// Unique-per-run ids/names — keeps repo-root runs (no bunfig preload, shared
// real state dir) green across repeated invocations. See adapter.test.ts.
const RUN = 200_000 + Math.floor(Math.random() * 1_000_000_000);
const FORUM_CHAT = RUN;
const room = (name: string): string => `${name}-${RUN.toString(36)}`;

const TMP = mkdtempSync(join(tmpdir(), "adapter-telegram-forum-"));
const DB_PATH = join(TMP, "mappings.db");

let fake: FakeTelegramClient;
let adapter: TelegramAdapterHandle;

function aiMessage(topicId: string, text: string): MessageDto {
  return {
    id: randomUUID(),
    topicId,
    authorId: "ai",
    text,
    createdAt: new Date().toISOString(),
  } as MessageDto;
}

beforeAll(() => {
  fake = new FakeTelegramClient();
  adapter = startTelegramAdapter({
    startTurn: () => null,
    client: fake,
    userId: USER,
    forumChatId: FORUM_CHAT,
    mappingDbPath: DB_PATH,
  });
});

afterAll(() => {
  adapter.stop();
});

describe("forum mode", () => {
  test("runtime topic-created materializes a forum thread, persists the mapping, and routes messages into it", async () => {
    const title = room("spawned");
    const topic = registerTopic({ title, userId: USER, agent: "codex" });
    await waitFor(() => fake.forumCalls.some((c) => c.name === title));
    expect(fake.forumCalls.find((c) => c.name === title)?.chatId).toBe(FORUM_CHAT);

    // Mapping is persisted — verify through an independent store instance.
    await waitFor(() => {
      const check = openMappingStore(DB_PATH);
      const found = check.load().some((m) => m.topicId === topic.id && m.chatId === FORUM_CHAT);
      check.close();
      return found;
    });
    const verify = openMappingStore(DB_PATH);
    const persisted = verify.load().find((m) => m.topicId === topic.id);
    verify.close();
    expect(persisted?.threadId).toBeGreaterThan(0);

    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "subagent says hi"));
    await waitFor(() => fake.calls.some((c) => c.text === "subagent says hi"));
    const call = fake.calls.find((c) => c.text === "subagent says hi")!;
    expect(call.chatId).toBe(FORUM_CHAT);
    expect(call.opts?.message_thread_id).toBe(persisted?.threadId);
    expect(call.opts?.parse_mode).toBe("HTML");
  });

  test("adapter-created topics (/new, inbound auto-create) do not double-materialize", async () => {
    const before = fake.forumCalls.length;
    fake.emit({ chat: { id: FORUM_CHAT }, from: { id: 1 }, text: `/new ${room("via-cmd")}` });
    await waitFor(() => fake.calls.some((c) => c.text.includes(room("via-cmd"))));
    expect(fake.forumCalls).toHaveLength(before); // no forum thread created for it
  });

  test("messages published while thread creation is in flight are buffered and flushed in order", async () => {
    fake.createMode = "manual";
    try {
      const title = room("buffered");
      const topic = registerTopic({ title, userId: USER });
      await waitFor(() => fake.forumCalls.some((c) => c.name === title));
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "first"));
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "second"));
      await Bun.sleep(20);
      expect(fake.calls.filter((c) => c.text === "first" || c.text === "second")).toHaveLength(0);

      fake.resolvePendingCreates();
      await waitFor(() => fake.calls.some((c) => c.text === "second"));
      const sent = fake.calls.filter((c) => c.text === "first" || c.text === "second");
      expect(sent.map((c) => c.text)).toEqual(["first", "second"]);
      const threadId = sent[0]?.opts?.message_thread_id;
      expect(threadId).toBeGreaterThan(0);
      expect(sent[1]?.opts?.message_thread_id).toBe(threadId as number);
    } finally {
      fake.createMode = "auto";
    }
  });

  test("createForumTopic failure falls back to the general chat with a title prefix and never retries", async () => {
    fake.createMode = "reject";
    try {
      const title = room("no-rights");
      const topic = registerTopic({ title, userId: USER });
      await waitFor(() => fake.forumCalls.some((c) => c.name === title));
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "m1"));
      await waitFor(() => fake.calls.some((c) => c.text === `[${title}] m1`));
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "m2"));
      await waitFor(() => fake.calls.some((c) => c.text === `[${title}] m2`));

      for (const text of [`[${title}] m1`, `[${title}] m2`]) {
        const call = fake.calls.find((c) => c.text === text)!;
        expect(call.chatId).toBe(FORUM_CHAT);
        expect(call.opts?.message_thread_id).toBeUndefined(); // general chat, no thread
      }
      // Tombstoned: exactly one creation attempt despite two later messages.
      expect(fake.forumCalls.filter((c) => c.name === title)).toHaveLength(1);
    } finally {
      fake.createMode = "auto";
    }
  });

  test("topic-deleted deletes the forum thread and drops the mapping", async () => {
    const title = room("doomed");
    const topic = registerTopic({ title, userId: USER });
    await waitFor(() => {
      const check = openMappingStore(DB_PATH);
      const found = check.load().some((m) => m.topicId === topic.id);
      check.close();
      return found;
    });
    const store = openMappingStore(DB_PATH);
    const threadId = store.load().find((m) => m.topicId === topic.id)?.threadId;
    store.close();

    runtimeBus().broadcastTopicDeleted(topic.id);
    await waitFor(() =>
      fake.deleteCalls.some((c) => c.chatId === FORUM_CHAT && c.threadId === threadId),
    );
    const after = openMappingStore(DB_PATH);
    expect(after.load().some((m) => m.topicId === topic.id)).toBe(false);
    after.close();
  });

  test("topics of other negotium users are not materialized", async () => {
    const title = room("foreign");
    registerTopic({ title, userId: "someone-else" });
    await Bun.sleep(20);
    expect(fake.forumCalls.some((c) => c.name === title)).toBe(false);
  });

  test("restart: a new adapter on the same mapping db routes old topics without re-creating threads", async () => {
    const RESTART_USER = "tg-restart-tester";
    const dbPath = join(TMP, "restart.db");
    const fakeA = new FakeTelegramClient();
    const adapterA = startTelegramAdapter({
      startTurn: () => null,
      client: fakeA,
      userId: RESTART_USER,
      forumChatId: FORUM_CHAT + 1,
      mappingDbPath: dbPath,
    });
    const title = room("survives");
    const topic = registerTopic({ title, userId: RESTART_USER });
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "before restart"));
    await waitFor(() => fakeA.calls.some((c) => c.text === "before restart"));
    const threadId = fakeA.calls.find((c) => c.text === "before restart")?.opts
      ?.message_thread_id as number;
    adapterA.stop();

    const fakeB = new FakeTelegramClient();
    const adapterB = startTelegramAdapter({
      startTurn: () => null,
      client: fakeB,
      userId: RESTART_USER,
      forumChatId: FORUM_CHAT + 1,
      mappingDbPath: dbPath,
    });
    try {
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "after restart"));
      await waitFor(() => fakeB.calls.some((c) => c.text === "after restart"));
      expect(fakeB.calls.find((c) => c.text === "after restart")?.opts?.message_thread_id).toBe(
        threadId,
      );
      expect(fakeB.forumCalls).toHaveLength(0); // routed via persisted mapping, not re-created
    } finally {
      adapterB.stop();
    }
  });
});

describe("DM fallback (no forumChatId)", () => {
  test("child-topic messages forward into the parent's chat with a title prefix", async () => {
    const DM_USER = "tg-dm-tester";
    const dmFake = new FakeTelegramClient();
    const dmAdapter = startTelegramAdapter({
      startTurn: () => null,
      client: dmFake,
      userId: DM_USER,
      mappingDbPath: join(TMP, "dm.db"),
    });
    try {
      const dmChat = FORUM_CHAT + 50;
      dmFake.emit({ chat: { id: dmChat }, from: { id: 1 }, text: `/new ${room("dm-parent")}` });
      await waitFor(() => dmFake.callsFor(dmChat).length > 0);
      const parent = getTopicByNameForUser(room("dm-parent"), DM_USER)!;

      // Simulate a spawn_subagent child: a topic parented to the mapped one.
      const child = registerTopic({ title: room("dm-child"), userId: DM_USER });
      updateTopic(child.id, { parentTopicId: parent.id });

      runtimeBus().broadcastMessage(child.id, aiMessage(child.id, "child output"));
      await waitFor(() =>
        dmFake.callsFor(dmChat).some((c) => c.text === `[${room("dm-child")}] child output`),
      );
      const call = dmFake.callsFor(dmChat).find((c) => c.text.includes("child output"))!;
      expect(call.opts?.parse_mode).toBe("HTML");
    } finally {
      dmAdapter.stop();
    }
  });
});
