/**
 * Regression tests for the 2026-07 review findings: forum-mode message drops,
 * mapping fan-out/eviction, stop() and topic-deleted races with in-flight
 * createForumTopic, send-queue watchdog, delivery error classification,
 * forum title cap, and the multi-hop DM parent fallback.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
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
import { openMappingStore, startTelegramAdapter } from "@/index";
import { FakeTelegramClient, waitFor } from "./fake-client";

// Unique-per-run ids/names — keeps repo-root runs (shared real state dir)
// green across repeated invocations. See adapter.test.ts.
const RUN = 300_000 + Math.floor(Math.random() * 1_000_000_000);
const room = (name: string): string => `${name}-${RUN.toString(36)}`;
const TMP = mkdtempSync(join(tmpdir(), "adapter-telegram-regressions-"));

let dbCounter = 0;
const freshDb = (): string => join(TMP, `db-${dbCounter++}.db`);
let chatCounter = 0;
const freshChat = (): number => RUN + 1000 * ++chatCounter;

function aiMessage(topicId: string, text: string): MessageDto {
  return {
    id: randomUUID(),
    topicId,
    authorId: "ai",
    text,
    createdAt: new Date().toISOString(),
  } as MessageDto;
}

describe("forum mode: unmapped live topics (finding 2)", () => {
  test("a bus message for a topic with no mapping lazily materializes a thread and is not dropped", async () => {
    const USER = `lazy-user-${RUN}`;
    const FORUM = freshChat();
    const title = room("lazy");
    // Created BEFORE the adapter exists — its topic-created broadcast is missed.
    const topic = registerTopic({ title, userId: USER });
    const foreign = registerTopic({ title: room("lazy-foreign"), userId: "someone-else" });

    const fake = new FakeTelegramClient();
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      forumChatId: FORUM,
      mappingDbPath: freshDb(),
    });
    try {
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "was almost dropped"));
      await waitFor(() => fake.calls.some((c) => c.text === "was almost dropped"));
      expect(fake.forumCalls.filter((c) => c.name === title)).toHaveLength(1);
      const call = fake.calls.find((c) => c.text === "was almost dropped")!;
      expect(call.chatId).toBe(FORUM);
      expect(call.opts?.message_thread_id).toBeGreaterThan(0);

      // Participant rule still applies on the lazy path: other users' rooms
      // are neither materialized nor delivered.
      runtimeBus().broadcastMessage(foreign.id, aiMessage(foreign.id, "foreign msg"));
      await Bun.sleep(30);
      expect(fake.forumCalls.some((c) => c.name.startsWith(room("lazy-foreign")))).toBe(false);
      expect(fake.calls.some((c) => c.text.includes("foreign msg"))).toBe(false);
    } finally {
      adapter.stop();
    }
  });

  test("creation-failure tombstones survive a restart: fallback keeps working, creation is not retried", async () => {
    const USER = `tomb-user-${RUN}`;
    const FORUM = freshChat();
    const dbPath = freshDb();
    const title = room("tombstoned");

    const fakeA = new FakeTelegramClient();
    fakeA.createMode = "reject";
    const adapterA = startTelegramAdapter({
      startTurn: () => null,
      client: fakeA,
      userId: USER,
      forumChatId: FORUM,
      mappingDbPath: dbPath,
    });
    const topic = registerTopic({ title, userId: USER });
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "m1"));
    await waitFor(() => fakeA.calls.some((c) => c.text === `[${title}] m1`));
    adapterA.stop();

    const fakeB = new FakeTelegramClient();
    const adapterB = startTelegramAdapter({
      startTurn: () => null,
      client: fakeB,
      userId: USER,
      forumChatId: FORUM,
      mappingDbPath: dbPath,
    });
    try {
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "m2"));
      await waitFor(() => fakeB.calls.some((c) => c.text === `[${title}] m2`));
      const call = fakeB.calls.find((c) => c.text === `[${title}] m2`)!;
      expect(call.chatId).toBe(FORUM);
      expect(call.opts?.message_thread_id).toBeUndefined(); // general chat
      expect(fakeB.forumCalls).toHaveLength(0); // no re-attempt after restart
    } finally {
      adapterB.stop();
    }
  });
});

describe("mapping fan-out and re-binding (finding 3)", () => {
  test("two chats bound to one topic both receive its messages; a /new re-bind detaches only its own chat", async () => {
    const USER = `fanout-user-${RUN}`;
    const shared = room("shared");
    const chatA = freshChat();
    const chatB = freshChat();
    const dbPath = freshDb();
    const fake = new FakeTelegramClient();
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      mappingDbPath: dbPath,
      topicTitleFor: () => shared, // every chat resolves to the same topic
    });
    try {
      fake.emit({ chat: { id: chatA }, from: { id: 1 }, text: "hello from A" });
      fake.emit({ chat: { id: chatB }, from: { id: 1 }, text: "hello from B" });
      const topic = getTopicByNameForUser(shared, USER)!;
      expect(topic).not.toBeNull();

      // Both bindings persisted — binding B must not steal the topic from A.
      const check = openMappingStore(dbPath);
      const rows = check.load().filter((m) => m.topicId === topic.id);
      check.close();
      expect(rows.map((m) => m.chatId).sort()).toEqual([chatA, chatB].sort());

      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "fan out"));
      await waitFor(
        () =>
          fake.callsFor(chatA).some((c) => c.text === "fan out") &&
          fake.callsFor(chatB).some((c) => c.text === "fan out"),
      );

      // Re-bind chat A to a fresh topic via /new: chat B keeps receiving.
      fake.emit({ chat: { id: chatA }, from: { id: 1 }, text: `/new ${room("rebound")}` });
      await waitFor(() => fake.callsFor(chatA).some((c) => c.text.includes(room("rebound"))));
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "after rebind"));
      await waitFor(() => fake.callsFor(chatB).some((c) => c.text === "after rebind"));
      expect(fake.callsFor(chatA).some((c) => c.text === "after rebind")).toBe(false);

      const after = openMappingStore(dbPath);
      const remaining = after.load().filter((m) => m.topicId === topic.id);
      after.close();
      expect(remaining.map((m) => m.chatId)).toEqual([chatB]);
    } finally {
      adapter.stop();
    }
  });

  test("legacy v1 db (UNIQUE topic_id) is migrated so a second binding no longer evicts the first", () => {
    const dbPath = freshDb();
    const legacy = new Database(dbPath);
    legacy.run(
      `CREATE TABLE IF NOT EXISTS mappings (
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL DEFAULT 0,
        topic_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (chat_id, thread_id),
        UNIQUE (topic_id)
      )`,
    );
    legacy.run(
      "INSERT INTO mappings (chat_id, thread_id, topic_id, created_at) VALUES (?, ?, ?, ?)",
      [111, 0, "topic-x", new Date().toISOString()],
    );
    legacy.close();

    const store = openMappingStore(dbPath);
    try {
      expect(store.load()).toEqual([{ chatId: 111, topicId: "topic-x" }]);
      store.save({ chatId: 222, topicId: "topic-x" }); // would have evicted chat 111 on v1
      expect(
        store
          .load()
          .map((m) => m.chatId)
          .sort(),
      ).toEqual([111, 222]);
    } finally {
      store.close();
    }
  });
});

describe("in-flight createForumTopic races (findings 4 & 5)", () => {
  test("stop() abandons a pending materialization: no post-stop sends, no closed-db save, no tombstone", async () => {
    const USER = `stoprace-user-${RUN}`;
    const FORUM = freshChat();
    const dbPath = freshDb();
    const fake = new FakeTelegramClient();
    fake.createMode = "manual";
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      forumChatId: FORUM,
      mappingDbPath: dbPath,
    });
    const topic = registerTopic({ title: room("stop-race"), userId: USER });
    await waitFor(() => fake.forumCalls.length === 1);
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "buffered then stopped"));

    adapter.stop();
    const attemptsBefore = fake.attempts.length;
    fake.resolvePendingCreates();
    await Bun.sleep(30);

    expect(fake.attempts.length).toBe(attemptsBefore); // buffered message never sent
    const check = openMappingStore(dbPath);
    expect(check.load()).toHaveLength(0); // nothing persisted after the store closed
    expect(check.loadTombstones()).toHaveLength(0); // not misclassified as creation failure
    check.close();
  });

  test("stop() while the pending creation is about to FAIL does not write a tombstone", async () => {
    const USER = `stopfail-user-${RUN}`;
    const dbPath = freshDb();
    const fake = new FakeTelegramClient();
    fake.createMode = "manual";
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      forumChatId: freshChat(),
      mappingDbPath: dbPath,
    });
    registerTopic({ title: room("stop-fail"), userId: USER });
    await waitFor(() => fake.forumCalls.length === 1);
    adapter.stop(); // store now closed; a tombstone write would throw
    fake.rejectPendingCreates(new Error("400 Bad Request: not enough rights"));
    await Bun.sleep(30);
    const check = openMappingStore(dbPath);
    expect(check.loadTombstones()).toHaveLength(0);
    check.close();
  });

  test("topic-deleted during materialization cancels it: the created thread is removed and nothing is bound", async () => {
    const USER = `delrace-user-${RUN}`;
    const FORUM = freshChat();
    const dbPath = freshDb();
    const fake = new FakeTelegramClient();
    fake.createMode = "manual";
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      forumChatId: FORUM,
      mappingDbPath: dbPath,
    });
    try {
      const expectedThreadId = fake.nextThreadId;
      const topic = registerTopic({ title: room("del-race"), userId: USER });
      await waitFor(() => fake.forumCalls.length === 1);
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "into the void"));

      runtimeBus().broadcastTopicDeleted(topic.id);
      fake.resolvePendingCreates();
      await waitFor(() =>
        fake.deleteCalls.some((c) => c.chatId === FORUM && c.threadId === expectedThreadId),
      );

      expect(fake.calls.some((c) => c.text.includes("into the void"))).toBe(false);
      const check = openMappingStore(dbPath);
      expect(check.load()).toHaveLength(0);
      check.close();
    } finally {
      adapter.stop();
    }
  });
});

describe("send queue watchdog (finding 6)", () => {
  test("a hung sendMessage is abandoned after the timeout and later messages still deliver", async () => {
    const USER = `hang-user-${RUN}`;
    const chatId = freshChat();
    const fake = new FakeTelegramClient();
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      mappingDbPath: freshDb(),
      sendTimeoutMs: 40,
    });
    try {
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/new ${room("hang")}` });
      await waitFor(() => fake.callsFor(chatId).length > 0);
      const topic = getTopicByNameForUser(room("hang"), USER)!;

      fake.sendMode = "hang";
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "never lands"));
      await waitFor(() => fake.attempts.some((c) => c.text === "never lands"));
      fake.sendMode = "auto";
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "lands anyway"));
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text === "lands anyway"));
      expect(fake.callsFor(chatId).some((c) => c.text === "never lands")).toBe(false);
    } finally {
      adapter.stop();
    }
  });
});

describe("deliver() error classification (finding 7)", () => {
  test("a non-parse error (403 blocked) drops the chunk without a plain-text resend", async () => {
    const USER = `blocked-user-${RUN}`;
    const chatId = freshChat();
    const fake = new FakeTelegramClient();
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      mappingDbPath: freshDb(),
    });
    try {
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/new ${room("blocked")}` });
      await waitFor(() => fake.callsFor(chatId).length > 0);
      const topic = getTopicByNameForUser(room("blocked"), USER)!;

      const blocked = new Error(
        "ETELEGRAM: 403 Forbidden: bot was blocked by the user",
      ) as Error & {
        response: unknown;
      };
      blocked.response = { statusCode: 403, body: { ok: false, error_code: 403 } };
      fake.failWith = blocked;
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "to a blocker"));
      await waitFor(() => fake.attempts.some((c) => c.text === "to a blocker"));
      await Bun.sleep(30);
      // Exactly one attempt (the HTML send) — no plain-text misclassification.
      expect(fake.attempts.filter((c) => c.text === "to a blocker")).toHaveLength(1);
      expect(fake.calls.some((c) => c.text === "to a blocker")).toBe(false);
    } finally {
      fake.failWith = null;
      adapter.stop();
    }
  });

  test("429 honors retry_after with one delayed retry that keeps the HTML formatting", async () => {
    const USER = `ratelimit-user-${RUN}`;
    const chatId = freshChat();
    const fake = new FakeTelegramClient();
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      mappingDbPath: freshDb(),
    });
    try {
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/new ${room("limited")}` });
      await waitFor(() => fake.callsFor(chatId).length > 0);
      const topic = getTopicByNameForUser(room("limited"), USER)!;

      fake.rateLimit429Next = 1;
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "**rate** limited"));
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text === "<b>rate</b> limited"));
      const attempts = fake.attempts.filter((c) => c.text === "<b>rate</b> limited");
      expect(attempts).toHaveLength(2); // original + one retry, both HTML
      expect(attempts.every((c) => c.opts?.parse_mode === "HTML")).toBe(true);
    } finally {
      adapter.stop();
    }
  });
});

describe("forum topic title cap (finding 8)", () => {
  test("createForumTopic names are truncated to 128 chars", async () => {
    const USER = `longtitle-user-${RUN}`;
    const fake = new FakeTelegramClient();
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      forumChatId: freshChat(),
      mappingDbPath: freshDb(),
    });
    try {
      const title = `${room("long")}-${"x".repeat(200)}`;
      registerTopic({ title, userId: USER });
      await waitFor(() => fake.forumCalls.length === 1);
      expect(fake.forumCalls[0]?.name).toBe(title.slice(0, 128));
      expect(fake.forumCalls[0]?.name.length).toBe(128);
    } finally {
      adapter.stop();
    }
  });
});

describe("DM fallback parent walk (finding 9)", () => {
  test("a grandchild topic forwards into the mapped grandparent's chat with its own title prefix", async () => {
    const USER = `walk-user-${RUN}`;
    const chatId = freshChat();
    const fake = new FakeTelegramClient();
    const adapter = startTelegramAdapter({
      startTurn: () => null,
      client: fake,
      userId: USER,
      mappingDbPath: freshDb(),
    });
    try {
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/new ${room("walk-root")}` });
      await waitFor(() => fake.callsFor(chatId).length > 0);
      const parent = getTopicByNameForUser(room("walk-root"), USER)!;
      const child = registerTopic({ title: room("walk-child"), userId: USER });
      updateTopic(child.id, { parentTopicId: parent.id });
      const grandchild = registerTopic({ title: room("walk-grandchild"), userId: USER });
      updateTopic(grandchild.id, { parentTopicId: child.id });

      runtimeBus().broadcastMessage(grandchild.id, aiMessage(grandchild.id, "deep output"));
      await waitFor(() =>
        fake.callsFor(chatId).some((c) => c.text === `[${room("walk-grandchild")}] deep output`),
      );

      // Cycle guard: a parent loop never delivers and never hangs.
      const loopA = registerTopic({ title: room("walk-loop-a"), userId: USER });
      const loopB = registerTopic({ title: room("walk-loop-b"), userId: USER });
      updateTopic(loopA.id, { parentTopicId: loopB.id });
      updateTopic(loopB.id, { parentTopicId: loopA.id });
      runtimeBus().broadcastMessage(loopA.id, aiMessage(loopA.id, "looped"));
      await Bun.sleep(30);
      expect(fake.calls.some((c) => c.text.includes("looped"))).toBe(false);
    } finally {
      adapter.stop();
    }
  });
});
