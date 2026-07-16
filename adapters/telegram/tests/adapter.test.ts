import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAllMessagesForTopic,
  getTopicByNameForUser,
  getTopicSessionId,
  type MessageDto,
  runtimeBus,
  setTopicSessionId,
  submitUserMessage,
  type TopicDto,
  upsertTopic,
} from "@negotium/core";
import type { TelegramAdapterHandle } from "@/index";
import { startTelegramAdapter } from "@/index";
import { FakeTelegramClient, waitFor } from "./fake-client";

const USER = "tg-tester";
const ALLOWED_TG_ID = 777;

// Unique-per-run chat ids and room names. The package-level `bunfig.toml`
// preload isolates state in a mkdtemp, but a repo-root `bun test` run has no
// preload (bun only reads bunfig from cwd) and shares the real state dir —
// unique names keep these tests green there too instead of tripping over
// "topic already exists" from a previous run.
const CHAT_BASE = 100_000 + Math.floor(Math.random() * 1_000_000_000);
const chat = (n: number): number => CHAT_BASE + n;
const room = (name: string): string => `${name}-${CHAT_BASE.toString(36)}`;

const TMP = mkdtempSync(join(tmpdir(), "adapter-telegram-dm-"));

let fake: FakeTelegramClient;
let adapter: TelegramAdapterHandle;

function inbound(chatId: number, text: string, threadId?: number, fromId = ALLOWED_TG_ID): void {
  fake.emit({
    chat: { id: chatId },
    from: { id: fromId },
    text,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    ...(threadId !== undefined ? { is_topic_message: true as const } : {}),
  });
}

function aiMessage(topicId: string, text: string, extra: Partial<MessageDto> = {}): MessageDto {
  return {
    id: randomUUID(),
    topicId,
    authorId: "ai",
    text,
    createdAt: new Date().toISOString(),
    ...extra,
  } as MessageDto;
}

/** Create a mapped topic via /new — binds the chat without starting an AI turn. */
async function mapChatToFreshTopic(
  chatId: number,
  title: string,
  threadId?: number,
): Promise<TopicDto> {
  inbound(chatId, `/new ${title}`, threadId);
  await waitFor(() => fake.callsFor(chatId).some((c) => c.text.includes(title)));
  const topic = getTopicByNameForUser(title, USER);
  if (!topic) throw new Error(`topic ${title} was not created`);
  return topic;
}

beforeAll(() => {
  fake = new FakeTelegramClient();
  adapter = startTelegramAdapter({
    startTurn: () => null,
    client: fake,
    userId: USER,
    allowedUsers: [String(ALLOWED_TG_ID)],
    mappingDbPath: join(TMP, "mappings.db"),
  });
});

afterAll(() => {
  adapter.stop();
});

describe("inbound", () => {
  test("publishes an inbound user message for simultaneous Terminal clients", () => {
    const chatId = chat(11);
    const seen: MessageDto[] = [];
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type === "message" && (event.payload as MessageDto).authorId === USER) {
        seen.push(event.payload as MessageDto);
      }
    });

    try {
      inbound(chatId, "visible in the terminal");
      const topic = getTopicByNameForUser(`tg-${chatId}`, USER);
      expect(topic).not.toBeNull();
      expect(seen.map((message) => [message.topicId, message.text])).toContainEqual([
        topic!.id,
        "visible in the terminal",
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("creates a topic per chat and persists the user message", () => {
    inbound(chat(1), "hello negotium");
    const topic = getTopicByNameForUser(`tg-${chat(1)}`, USER);
    expect(topic).not.toBeNull();
    // defaultAgent unset → registerTopic's agent-room default (maestro).
    expect(topic?.agent).toBe("maestro");
    const rows = getAllMessagesForTopic(topic!.id);
    const userRow = rows.find((r) => r.author_id === USER);
    expect(userRow?.text).toBe("hello negotium");
  });

  test("reuses the mapping on subsequent messages (no duplicate topic)", () => {
    inbound(chat(1), "second message");
    const topic = getTopicByNameForUser(`tg-${chat(1)}`, USER);
    const texts = getAllMessagesForTopic(topic!.id)
      .filter((r) => r.author_id === USER)
      .map((r) => r.text);
    expect(texts).toEqual(["hello negotium", "second message"]);
  });

  test("whitelist rejection is silent and creates no topic", () => {
    inbound(chat(2), "let me in", undefined, 999);
    expect(getTopicByNameForUser(`tg-${chat(2)}`, USER)).toBeNull();
    expect(fake.callsFor(chat(2))).toHaveLength(0);
  });

  test("forum thread gets its own topic, separate from the chat's", () => {
    inbound(chat(6), "root chat message");
    inbound(chat(6), "thread message", 55);
    const chatTopic = getTopicByNameForUser(`tg-${chat(6)}`, USER);
    const threadTopic = getTopicByNameForUser(`tg-${chat(6)}-55`, USER);
    expect(chatTopic).not.toBeNull();
    expect(threadTopic).not.toBeNull();
    expect(chatTopic!.id).not.toBe(threadTopic!.id);
    const threadRows = getAllMessagesForTopic(threadTopic!.id);
    expect(threadRows.some((r) => r.text === "thread message")).toBe(true);
  });
});

describe("commands", () => {
  test("/new creates and switches to a fresh topic", async () => {
    const topic = await mapChatToFreshTopic(chat(3), room("my-room"));
    expect(topic.kind).toBe("agent");
    const reply = fake.callsFor(chat(3)).at(-1);
    expect(reply?.text).toBe(`switched to new topic "${room("my-room")}"`);
  });

  test("/new with a conflicting name replies the validation error", async () => {
    inbound(chat(3), `/new ${room("my-room")}`);
    await waitFor(() => fake.callsFor(chat(3)).some((c) => c.text.includes("already exists")));
  });

  test("/new without a name resets the mapped topic session in place", async () => {
    const topic = getTopicByNameForUser(room("my-room"), USER);
    expect(topic).not.toBeNull();
    setTopicSessionId(topic!.id, "telegram-reset-session", {
      reason: "test",
      agent: topic!.agent,
    });
    inbound(chat(3), "/new");
    await waitFor(() =>
      fake
        .callsFor(chat(3))
        .some(
          (call) =>
            call.text === `Session reset for "${room("my-room")}". The next message starts fresh.`,
        ),
    );
    expect(getTopicSessionId(topic!.id)).toBeNull();
  });

  test("/topics and /load exclude hidden adapter topics", async () => {
    const hiddenId = `hidden-${randomUUID()}`;
    const now = new Date().toISOString();
    upsertTopic({
      id: hiddenId,
      title: room("hidden-otium-mirror"),
      kind: "agent",
      agent: "maestro",
      aiMode: "always",
      defaultModel: "",
      defaultEffort: "medium",
      participants: [{ userId: USER, role: "owner" }],
      visibility: "hidden",
      createdAt: now,
      lastMessageAt: now,
    });
    inbound(chat(3), "/topics");
    await waitFor(() =>
      fake.callsFor(chat(3)).some((c) => c.text.includes(`- ${room("my-room")} (maestro)`)),
    );
    const listing = fake.callsFor(chat(3)).at(-1)!.text;
    expect(listing).toContain(`- tg-${chat(1)} (maestro)`);
    expect(listing).not.toContain(room("hidden-otium-mirror"));

    inbound(chat(31), `/load ${hiddenId}`);
    await waitFor(() =>
      fake.callsFor(chat(31)).some((c) => c.text === `no visible topic matching "${hiddenId}"`),
    );
  });

  test("/agent switches the chat to an agent-suffixed topic", async () => {
    inbound(chat(4), "/agent claude");
    await waitFor(() => fake.callsFor(chat(4)).length > 0);
    expect(fake.callsFor(chat(4)).at(-1)?.text).toBe(
      `agent set to claude — topic "tg-${chat(4)}-claude"`,
    );
    const topic = getTopicByNameForUser(`tg-${chat(4)}-claude`, USER);
    expect(topic?.agent).toBe("claude");
  });

  test("/agent with an unknown agent replies usage", async () => {
    inbound(chat(4), "/agent gpt-99");
    await waitFor(() =>
      fake.callsFor(chat(4)).some((c) => c.text === "usage: /agent <claude|codex|maestro>"),
    );
  });

  test("/abort with nothing running says so", async () => {
    inbound(chat(5), "/abort");
    await waitFor(() => fake.callsFor(chat(5)).some((c) => c.text === "nothing running"));
  });
});

describe("outbound", () => {
  test("renders bus messages as HTML into the mapped chat", async () => {
    const topic = await mapChatToFreshTopic(chat(7), room("outbound-room"));
    const before = fake.callsFor(chat(7)).length;
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "**bold** reply"));
    await waitFor(() => fake.callsFor(chat(7)).length > before);
    const call = fake.callsFor(chat(7)).at(-1)!;
    expect(call.text).toBe("<b>bold</b> reply");
    expect(call.opts?.parse_mode).toBe("HTML");
  });

  test("splits >4096-char messages into ordered chunks", async () => {
    const topic = getTopicByNameForUser(room("outbound-room"), USER)!;
    const before = fake.callsFor(chat(7)).length;
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "x".repeat(9000)));
    await waitFor(() => fake.callsFor(chat(7)).length === before + 3);
    const chunks = fake.callsFor(chat(7)).slice(before);
    expect(chunks.map((c) => c.text.length)).toEqual([4096, 4096, 808]);
    expect(chunks.map((c) => c.text).join("")).toBe("x".repeat(9000));
  });

  test("skips tool-kind messages and echoes originating from Telegram", async () => {
    const topic = getTopicByNameForUser(room("outbound-room"), USER)!;
    const before = fake.callsFor(chat(7)).length;
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "tool noise", { kind: "tool" }));
    runtimeBus().broadcastMessage(
      topic.id,
      aiMessage(topic.id, "echo", { authorId: USER, sourceAdapter: "telegram" }),
    );
    await Bun.sleep(30);
    expect(fake.callsFor(chat(7))).toHaveLength(before);
  });

  test("shows tool calls in one temporary message and deletes it when the turn ends", async () => {
    const topic = getTopicByNameForUser(room("outbound-room"), USER)!;
    const queryId = room("tool-status");
    const before = fake.callsFor(chat(7)).length;
    const progressMessageId = fake.nextMessageId;

    runtimeBus().broadcastToolCall(
      topic.id,
      queryId,
      "Bash",
      { command: "git status --short" },
      "Bash(git status --short)",
      "tool-1",
    );
    await waitFor(() => fake.callsFor(chat(7)).length > before);
    expect(fake.callsFor(chat(7)).at(-1)?.text).toBe("🔧 Bash(git status --short)");

    runtimeBus().broadcastToolCall(
      topic.id,
      queryId,
      "Read",
      { file_path: "/tmp/example.ts" },
      "Read(/tmp/example.ts)",
      "tool-2",
    );
    await waitFor(() => fake.editCalls.some((call) => call.text === "🔧 Read(/tmp/example.ts)"));
    expect(fake.editCalls.at(-1)?.opts.message_id).toBe(progressMessageId);

    fake.failNextEdits = { count: 1, error: new Error("message cannot be edited") };
    const replacementMessageId = fake.nextMessageId;
    runtimeBus().broadcastToolCall(
      topic.id,
      queryId,
      "Grep",
      { pattern: "TODO" },
      "Grep(TODO)",
      "tool-3",
    );
    await waitFor(() =>
      fake.deletedMessageCalls.some(
        (call) => call.chatId === chat(7) && call.messageId === progressMessageId,
      ),
    );
    await waitFor(() => fake.callsFor(chat(7)).some((call) => call.text === "🔧 Grep(TODO)"));

    runtimeBus().broadcastDone(topic.id, queryId);
    await waitFor(() =>
      fake.deletedMessageCalls.some(
        (call) => call.chatId === chat(7) && call.messageId === replacementMessageId,
      ),
    );
  });

  test("relays the same user's Terminal message into a mapped Telegram chat", async () => {
    const topic = getTopicByNameForUser(room("outbound-room"), USER)!;
    const before = fake.callsFor(chat(7)).length;
    submitUserMessage({
      topic,
      userId: USER,
      text: "written from terminal",
      sourceAdapter: "terminal",
      startTurn: () => null,
    });
    await waitFor(() => fake.callsFor(chat(7)).length > before);
    expect(fake.callsFor(chat(7)).at(-1)?.text).toBe("[From: User] written from terminal");
  });

  test("relays tell_session messages received from another topic", async () => {
    const topic = getTopicByNameForUser(room("outbound-room"), USER)!;
    const before = fake.callsFor(chat(7)).length;

    runtimeBus().broadcastMessage(topic.id, {
      id: randomUUID(),
      topicId: topic.id,
      authorId: "system",
      sourceAdapter: "session-comm",
      text: "[Tell from **research**]\n\nReview the deployment result.",
      createdAt: new Date().toISOString(),
    });

    await waitFor(() => fake.callsFor(chat(7)).length > before);
    expect(fake.callsFor(chat(7)).at(-1)?.text).toContain("Tell from <b>research</b>");
    expect(fake.callsFor(chat(7)).at(-1)?.text).toContain("Review the deployment result.");
  });

  test("falls back to plain text when Telegram rejects the HTML", async () => {
    const topic = getTopicByNameForUser(room("outbound-room"), USER)!;
    const before = fake.callsFor(chat(7)).length;
    fake.rejectHtml = true;
    try {
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "**broken** html"));
      await waitFor(() => fake.callsFor(chat(7)).length > before);
    } finally {
      fake.rejectHtml = false;
    }
    const call = fake.callsFor(chat(7)).at(-1)!;
    expect(call.text).toBe("**broken** html"); // plain markdown, not HTML
    expect(call.opts?.parse_mode).toBeUndefined();
  });

  test("replies into the forum thread the mapping came from", async () => {
    const topic = await mapChatToFreshTopic(chat(8), room("thread-room"), 66);
    const before = fake.callsFor(chat(8)).length;
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "threaded reply"));
    await waitFor(() => fake.callsFor(chat(8)).length > before);
    const call = fake.callsFor(chat(8)).at(-1)!;
    expect(call.opts?.message_thread_id).toBe(66);
  });
});

describe("stop", () => {
  test("unsubscribes from the bus and ignores further inbound", async () => {
    const fake2 = new FakeTelegramClient();
    const adapter2 = startTelegramAdapter({
      startTurn: () => null,
      client: fake2,
      userId: USER,
      mappingDbPath: join(TMP, "stop.db"),
    });
    fake2.emit({ chat: { id: chat(9) }, from: { id: 1 }, text: `/new ${room("stop-room")}` });
    await waitFor(() => fake2.callsFor(chat(9)).length > 0);
    const topic = getTopicByNameForUser(room("stop-room"), USER)!;

    adapter2.stop();
    const before = fake2.calls.length;
    runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "after stop"));
    fake2.emit({ chat: { id: chat(10) }, from: { id: 1 }, text: "hello?" });
    await Bun.sleep(30);
    expect(fake2.calls).toHaveLength(before);
    expect(getTopicByNameForUser(`tg-${chat(10)}`, USER)).toBeNull();
  });
});
