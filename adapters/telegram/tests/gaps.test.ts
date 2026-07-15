/**
 * Feature-parity tests (clawgram gap-closing pass): /del //del! //fork //spawn
 * commands, inbound attachments (photo/document/voice) through core's intake,
 * outbound [FILE:] delivery, typing indicator, durable retry outbox, and the
 * optional turn footer.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAllMessagesForTopic,
  getTopic,
  getTopicByNameForUser,
  type MessageDto,
  runtimeBus,
  WORKSPACE_DIR,
} from "@negotium/core";
import type { TelegramAdapterHandle, TelegramAdapterOptions } from "@/index";
import { openMappingStore, startTelegramAdapter } from "@/index";
import { FakeTelegramClient, waitFor } from "./fake-client";

const RUN = 400_000 + Math.floor(Math.random() * 1_000_000_000);
const room = (name: string): string => `${name}-${RUN.toString(36)}`;
const TMP = mkdtempSync(join(tmpdir(), "adapter-telegram-gaps-"));

let dbCounter = 0;
const freshDb = (): string => join(TMP, `db-${dbCounter++}.db`);
let chatCounter = 0;
const freshChat = (): number => RUN + 1000 * ++chatCounter;
let userCounter = 0;
const freshUser = (): string => `gaps-user-${RUN}-${++userCounter}`;

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

/** Data URLs keep attachment tests network- and port-free. */
const served = new Map<string, string | Uint8Array>();
function servedUrl(key: string): string {
  const body = served.get(key);
  if (body === undefined) throw new Error(`missing served test fixture: ${key}`);
  return `data:application/octet-stream;base64,${Buffer.from(body).toString("base64")}`;
}

function startAdapter(overrides: Partial<TelegramAdapterOptions> & { userId: string }): {
  fake: FakeTelegramClient;
  adapter: TelegramAdapterHandle;
} {
  const fake = new FakeTelegramClient();
  const adapter = startTelegramAdapter({
    startTurn: () => null,
    client: fake,
    mappingDbPath: freshDb(),
    ...overrides,
  });
  return { fake, adapter };
}

async function mapChat(fake: FakeTelegramClient, chatId: number, title: string): Promise<void> {
  fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/new ${title}` });
  await waitFor(() => fake.callsFor(chatId).some((c) => c.text.includes(title)));
}

describe("commands: /fork and /spawn", () => {
  test("/fork derives a history-copying child of the current topic", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("fork-src"));
      const src = getTopicByNameForUser(room("fork-src"), USER)!;
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/fork ${room("fork-child")}` });
      await waitFor(() =>
        fake.callsFor(chatId).some((c) => c.text === `forked into "${room("fork-child")}"`),
      );
      const child = getTopicByNameForUser(room("fork-child"), USER)!;
      expect(child.parentTopicId).toBe(src.id);
      expect(child.isFork).toBe(true);
    } finally {
      adapter.stop();
    }
  });

  test("/spawn derives a fresh-session child (no history copy)", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("spawn-src"));
      const src = getTopicByNameForUser(room("spawn-src"), USER)!;
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/spawn ${room("spawn-child")}` });
      await waitFor(() =>
        fake.callsFor(chatId).some((c) => c.text === `spawned "${room("spawn-child")}"`),
      );
      const child = getTopicByNameForUser(room("spawn-child"), USER)!;
      expect(child.parentTopicId).toBe(src.id);
      expect(child.isFork).toBeFalsy();
    } finally {
      adapter.stop();
    }
  });

  test("/fork replies with usage feedback in an unmapped chat and on name conflicts", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: "/fork whatever" });
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text.includes("nothing to fork")));
      await mapChat(fake, chatId, room("conflict-src"));
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/fork ${room("conflict-src")}` });
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text.includes("already exists")));
    } finally {
      adapter.stop();
    }
  });
});

describe("cross-adapter topic loading", () => {
  test("/load binds an existing topic into an unmapped chat and /unload preserves it", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const creatorChat = freshChat();
    const targetChat = freshChat();
    const title = room("shared-load");
    try {
      await mapChat(fake, creatorChat, title);
      const topic = getTopicByNameForUser(title, USER)!;

      fake.emit({ chat: { id: targetChat }, from: { id: 1 }, text: `/load ${topic.id}` });
      await waitFor(() =>
        fake.callsFor(targetChat).some((call) => call.text === `loaded topic "${title}"`),
      );
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "shared answer"));
      await waitFor(() => fake.callsFor(targetChat).some((call) => call.text === "shared answer"));

      fake.emit({ chat: { id: targetChat }, from: { id: 1 }, text: "/unload" });
      await waitFor(() =>
        fake
          .callsFor(targetChat)
          .some((call) => call.text === "unloaded topic; the Negotium topic was preserved"),
      );
      const before = fake.callsFor(targetChat).length;
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "after unload"));
      await Bun.sleep(20);
      expect(fake.callsFor(targetChat)).toHaveLength(before);
      expect(getTopic(topic.id)).not.toBeNull();
    } finally {
      adapter.stop();
    }
  });
});

describe("commands: /del and /del!", () => {
  test("/del deletes the current chat's topic and drops its mapping", async () => {
    const USER = freshUser();
    const dbPath = freshDb();
    const { fake, adapter } = startAdapter({ userId: USER, mappingDbPath: dbPath });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("del-me"));
      const topic = getTopicByNameForUser(room("del-me"), USER)!;
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: "/del" });
      await waitFor(() => getTopic(topic.id) === null);
      await waitFor(() =>
        fake.callsFor(chatId).some((c) => c.text === `deleting topic "${room("del-me")}"…`),
      );
      const check = openMappingStore(dbPath);
      expect(check.load().some((m) => m.topicId === topic.id)).toBe(false);
      check.close();
    } finally {
      adapter.stop();
    }
  });

  test("/del <name> targets a topic by name; unknown names get feedback", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    const otherChat = freshChat();
    try {
      await mapChat(fake, otherChat, room("del-named"));
      const target = getTopicByNameForUser(room("del-named"), USER)!;
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/del ${room("del-named")}` });
      await waitFor(() => getTopic(target.id) === null);

      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: "/del nope-does-not-exist" });
      await waitFor(() =>
        fake.callsFor(chatId).some((c) => c.text === `no topic named "nope-does-not-exist"`),
      );
    } finally {
      adapter.stop();
    }
  });

  test("archive failure blocks /del with an explanation; /del! force-deletes", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    // Block core's archive step: the archive dir path is occupied by a FILE,
    // so mkdir fails and deleteTopicCascade throws TopicArchiveRequiredError.
    const archiveBlock = join(WORKSPACE_DIR, "wiki", "archive");
    mkdirSync(join(WORKSPACE_DIR, "wiki"), { recursive: true });
    // Other monorepo tests may already have created the normal archive directory.
    rmSync(archiveBlock, { force: true, recursive: true });
    writeFileSync(archiveBlock, "block");
    try {
      // The topic needs at least one message — archives of empty topics no-op.
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: "remember this line" });
      await waitFor(() => {
        const candidate = getTopicByNameForUser(`tg-${chatId}`, USER);
        return Boolean(candidate && getAllMessagesForTopic(candidate.id).length > 0);
      });
      const topic = getTopicByNameForUser(`tg-${chatId}`, USER)!;
      expect(getAllMessagesForTopic(topic.id).length).toBeGreaterThan(0);

      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: "/del" });
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text.includes("delete blocked")));
      expect(getTopic(topic.id)).not.toBeNull();
      expect(fake.callsFor(chatId).find((c) => c.text.includes("delete blocked"))?.text).toContain(
        "/del!",
      );

      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: "/del!" });
      await waitFor(() => getTopic(topic.id) === null);
    } finally {
      rmSync(archiveBlock, { force: true });
      adapter.stop();
    }
  });
});

describe("inbound attachments", () => {
  test("photo + caption: downloads the highest-resolution variant into the topic workspace and prompts with the core convention", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      served.set("photo-small", "SMALL");
      served.set("photo-big", "BIG-PHOTO-BYTES");
      fake.fileLinks.set("photo-small", servedUrl("photo-small"));
      fake.fileLinks.set("photo-big", servedUrl("photo-big"));
      fake.emit({
        chat: { id: chatId },
        from: { id: 1 },
        caption: "what is in this picture?",
        photo: [{ file_id: "photo-small" }, { file_id: "photo-big" }],
      });

      const topicTitle = `tg-${chatId}`;
      await waitFor(() => {
        const topic = getTopicByNameForUser(topicTitle, USER);
        return Boolean(
          topic &&
            getAllMessagesForTopic(topic.id).some(
              (r) => r.author_id === USER && r.text.includes("[Attached file: photo.jpg"),
            ),
        );
      });
      const topic = getTopicByNameForUser(topicTitle, USER)!;
      const row = getAllMessagesForTopic(topic.id).find((r) => r.author_id === USER)!;
      expect(row.text.startsWith("what is in this picture?")).toBe(true);
      const path = /\[Attached file: photo\.jpg at path: ([^\]]+)\]/.exec(row.text)?.[1];
      expect(path).toBeDefined();
      expect(readFileSync(path!, "utf-8")).toBe("BIG-PHOTO-BYTES"); // highest-res variant
      expect(path!.includes("uploads")).toBe(true);
    } finally {
      adapter.stop();
    }
  });

  test("document: keeps its filename and lands on disk", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      served.set("doc-1", "csv,content\n1,2");
      fake.fileLinks.set("doc-1", servedUrl("doc-1"));
      fake.emit({
        chat: { id: chatId },
        from: { id: 1 },
        document: { file_id: "doc-1", file_name: "data.csv" },
      });
      await waitFor(() => {
        const topic = getTopicByNameForUser(`tg-${chatId}`, USER);
        return Boolean(
          topic &&
            getAllMessagesForTopic(topic.id).some((r) =>
              r.text.includes("[Attached file: data.csv"),
            ),
        );
      });
      const topic = getTopicByNameForUser(`tg-${chatId}`, USER)!;
      const row = getAllMessagesForTopic(topic.id).find((r) => r.author_id === USER)!;
      const path = /\[Attached file: data\.csv at path: ([^\]]+)\]/.exec(row.text)?.[1];
      expect(readFileSync(path!, "utf-8")).toBe("csv,content\n1,2");
      // No caption → core's canonical "please check this file" ask.
      expect(row.text.startsWith("이 파일을 확인해주세요.")).toBe(true);
    } finally {
      adapter.stop();
    }
  });

  test("voice without a transcriber gets a polite reply and starts no turn", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      fake.emit({
        chat: { id: chatId },
        from: { id: 1 },
        voice: { file_id: "voice-x", duration: 3 },
      });
      await waitFor(() =>
        fake.callsFor(chatId).some((c) => c.text.includes("voice transcription is not configured")),
      );
      const topic = getTopicByNameForUser(`tg-${chatId}`, USER)!;
      expect(getAllMessagesForTopic(topic.id).some((r) => r.author_id === USER)).toBe(false);
    } finally {
      adapter.stop();
    }
  });

  test("voice with a transcriber turns the transcript into the prompt", async () => {
    const USER = freshUser();
    const transcribed: string[] = [];
    const { fake, adapter } = startAdapter({
      userId: USER,
      transcribe: async (filePath) => {
        transcribed.push(filePath);
        return "hello from my voice";
      },
    });
    const chatId = freshChat();
    try {
      served.set("voice-1", "OGGBYTES");
      fake.fileLinks.set("voice-1", servedUrl("voice-1"));
      fake.emit({
        chat: { id: chatId },
        from: { id: 1 },
        voice: { file_id: "voice-1", duration: 3 },
      });
      await waitFor(() => {
        const topic = getTopicByNameForUser(`tg-${chatId}`, USER);
        return Boolean(topic && getAllMessagesForTopic(topic.id).some((r) => r.author_id === USER));
      });
      const topic = getTopicByNameForUser(`tg-${chatId}`, USER)!;
      const row = getAllMessagesForTopic(topic.id).find((r) => r.author_id === USER)!;
      expect(row.text).toBe("[Voice transcript]\nhello from my voice");
      expect(transcribed).toHaveLength(1);
      expect(readFileSync(transcribed[0]!, "utf-8")).toBe("OGGBYTES");
    } finally {
      adapter.stop();
    }
  });
});

describe("outbound files", () => {
  test("[FILE:] tags are stripped from text and sent as photo/document by extension", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("files-out"));
      const topic = getTopicByNameForUser(room("files-out"), USER)!;
      const pdf = join(TMP, "report.pdf");
      const png = join(TMP, "chart.png");
      writeFileSync(pdf, "pdf-bytes");
      writeFileSync(png, "png-bytes");

      runtimeBus().broadcastMessage(
        topic.id,
        aiMessage(topic.id, `done, see [FILE:${pdf}] and [FILE:${png}]`),
      );
      await waitFor(() => fake.photoCalls.length > 0 && fake.docCalls.length > 0);
      expect(fake.docCalls[0]).toMatchObject({ chatId, path: pdf });
      expect(fake.photoCalls[0]).toMatchObject({ chatId, path: png });
      const textCall = fake.callsFor(chatId).at(-1)!;
      expect(textCall.text).toBe("done, see  and"); // tags stripped
      expect(textCall.text.includes("[FILE:")).toBe(false);
    } finally {
      adapter.stop();
    }
  });

  test("a supersede tombstone removes delivered text and file messages", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("files-supersede"));
      const topic = getTopicByNameForUser(room("files-supersede"), USER)!;
      const pdf = join(TMP, "obsolete-report.pdf");
      writeFileSync(pdf, "obsolete-pdf");
      const message = aiMessage(topic.id, `obsolete [FILE:${pdf}]`, {
        queryId: "files-supersede-query",
      });

      runtimeBus().broadcastMessage(topic.id, message);
      await waitFor(
        () =>
          fake.callsFor(chatId).some((call) => call.text.trim() === "obsolete") &&
          fake.docCalls.some((call) => call.path === pdf),
      );

      runtimeBus().broadcastMessageUpdated(topic.id, message.id, {
        deleted: true,
        text: "",
      });

      await waitFor(() => fake.deletedMessageCalls.length >= 2);
      expect(fake.deletedMessageCalls.filter((call) => call.chatId === chatId)).toHaveLength(2);
    } finally {
      adapter.stop();
    }
  });

  test("sensitive paths are blocked; missing files surface a path notice", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("files-guard"));
      const topic = getTopicByNameForUser(room("files-guard"), USER)!;

      runtimeBus().broadcastMessage(
        topic.id,
        aiMessage(topic.id, "key [FILE:/Users/nobody/.ssh/id_rsa]"),
      );
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text === "key"));
      expect(fake.docCalls.some((c) => c.path.includes(".ssh"))).toBe(false);
      expect(fake.photoCalls.some((c) => c.path.includes(".ssh"))).toBe(false);
      expect(fake.callsFor(chatId).some((c) => c.text.includes("id_rsa"))).toBe(false);

      const missing = join(TMP, "never-created.txt");
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, `gone [FILE:${missing}]`));
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text === `File: ${missing}`));
      expect(fake.docCalls.some((c) => c.path === missing)).toBe(false);
    } finally {
      adapter.stop();
    }
  });
});

describe("typing indicator", () => {
  test("ai_active keeps the typing action alive until the turn finishes", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER, typingHeartbeatMs: 10 });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("typing-room"));
      const topic = getTopicByNameForUser(room("typing-room"), USER)!;
      runtimeBus().broadcastAiActive(topic.id, "query-1");
      await waitFor(
        () =>
          fake.chatActions.filter((a) => a.chatId === chatId && a.action === "typing").length >= 2,
      );
      runtimeBus().broadcastDone(topic.id, "query-1");
      const stoppedAt = fake.chatActions.length;
      await Bun.sleep(40);
      expect(fake.chatActions).toHaveLength(stoppedAt);
    } finally {
      adapter.stop();
    }
  });

  test("a session-retry abort clears the superseded query heartbeat", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER, typingHeartbeatMs: 10 });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("typing-retry-room"));
      const topic = getTopicByNameForUser(room("typing-retry-room"), USER)!;
      runtimeBus().broadcastAiActive(topic.id, "expired-query");
      await waitFor(() => fake.chatActions.filter((a) => a.chatId === chatId).length >= 2);
      runtimeBus().broadcastAborted(topic.id, "expired-query", "stopped");
      runtimeBus().broadcastAiActive(topic.id, "retry-query");
      runtimeBus().broadcastDone(topic.id, "retry-query");

      const stoppedAt = fake.chatActions.length;
      await Bun.sleep(40);
      expect(fake.chatActions).toHaveLength(stoppedAt);
    } finally {
      adapter.stop();
    }
  });
});

describe("durable retry outbox", () => {
  const serverError = (): Error & { response: unknown } => {
    const err = new Error("ETELEGRAM: 502 Bad Gateway") as Error & { response: unknown };
    err.response = { statusCode: 502, body: { ok: false, error_code: 502 } };
    return err;
  };

  test("a transient failure is queued and flushed once the API recovers", async () => {
    const USER = freshUser();
    const dbPath = freshDb();
    const { fake, adapter } = startAdapter({
      userId: USER,
      mappingDbPath: dbPath,
      outbox: { pollMs: 20, baseDelayMs: 10 },
    });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("retry-room"));
      const topic = getTopicByNameForUser(room("retry-room"), USER)!;
      fake.failNextSends = { count: 1, error: serverError() };
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "retry me please"));
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text === "retry me please"));
      expect(fake.attempts.filter((c) => c.text === "retry me please")).toHaveLength(2);
      // Queue drained — nothing left pending or dead.
      const check = openMappingStore(dbPath);
      expect(check.outboxAll()).toHaveLength(0);
      check.close();
    } finally {
      adapter.stop();
    }
  });

  test("a supersede tombstone cancels a pending durable retry", async () => {
    const USER = freshUser();
    const dbPath = freshDb();
    const { fake, adapter } = startAdapter({
      userId: USER,
      mappingDbPath: dbPath,
      outbox: { pollMs: 10, baseDelayMs: 80 },
    });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("retry-cancel-room"));
      const topic = getTopicByNameForUser(room("retry-cancel-room"), USER)!;
      const message = aiMessage(topic.id, "obsolete retry", { queryId: "retry-cancel-query" });
      fake.failNextSends = { count: 1, error: serverError() };

      runtimeBus().broadcastMessage(topic.id, message);
      await waitFor(() => {
        const check = openMappingStore(dbPath);
        const queued = check.outboxAll().some((entry) => entry.runtimeMessageId === message.id);
        check.close();
        return queued;
      });

      runtimeBus().broadcastMessageUpdated(topic.id, message.id, {
        deleted: true,
        text: "",
      });
      await Bun.sleep(120);

      expect(fake.attempts.filter((call) => call.text === message.text)).toHaveLength(1);
      expect(fake.callsFor(chatId).some((call) => call.text === message.text)).toBe(false);
      const check = openMappingStore(dbPath);
      expect(check.outboxAll().some((entry) => entry.runtimeMessageId === message.id)).toBe(false);
      check.close();
    } finally {
      adapter.stop();
    }
  });

  test("persistent failure dead-letters after max attempts and is never retried again", async () => {
    const USER = freshUser();
    const dbPath = freshDb();
    const { fake, adapter } = startAdapter({
      userId: USER,
      mappingDbPath: dbPath,
      outbox: { pollMs: 10, baseDelayMs: 2, maxAttempts: 3 },
    });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("dead-room"));
      const topic = getTopicByNameForUser(room("dead-room"), USER)!;
      fake.failWith = serverError();
      runtimeBus().broadcastMessage(topic.id, aiMessage(topic.id, "doomed message"));
      await waitFor(() => {
        const check = openMappingStore(dbPath);
        const dead = check.outboxAll().some((e) => e.dead);
        check.close();
        return dead;
      });
      const check = openMappingStore(dbPath);
      const entry = check.outboxAll().find((e) => e.dead)!;
      check.close();
      expect(entry.attempts).toBe(3);
      expect(entry.plain).toContain("doomed message");

      // API recovers — the dead row must stay dead (no zombie delivery).
      fake.failWith = null;
      await Bun.sleep(60);
      expect(fake.callsFor(chatId).some((c) => c.text === "doomed message")).toBe(false);
    } finally {
      adapter.stop();
    }
  });
});

describe("media groups (albums)", () => {
  /** Register `n` served photo files and return their file_ids. */
  function servePhotos(prefix: string, n: number): string[] {
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      const id = `${prefix}-${i}`;
      served.set(id, `bytes-of-${id}`);
      ids.push(id);
    }
    return ids;
  }

  function albumPhoto(
    fake: FakeTelegramClient,
    chatId: number,
    groupId: string,
    fileId: string,
    caption?: string,
  ): void {
    fake.fileLinks.set(fileId, servedUrl(fileId));
    fake.emit({
      chat: { id: chatId },
      from: { id: 1 },
      media_group_id: groupId,
      photo: [{ file_id: fileId }],
      ...(caption !== undefined ? { caption } : {}),
    });
  }

  const userRows = (user: string, chatId: number) => {
    const topic = getTopicByNameForUser(`tg-${chatId}`, user);
    return topic ? getAllMessagesForTopic(topic.id).filter((r) => r.author_id === user) : [];
  };

  test("a 3-photo album becomes exactly ONE turn with all attachments and the combined caption", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({
      userId: USER,
      mediaGroup: { debounceMs: 30, maxWaitMs: 500 },
    });
    const chatId = freshChat();
    try {
      const [p1, p2, p3] = servePhotos(`album-${RUN}`, 3);
      albumPhoto(fake, chatId, "g-1", p1!, "holiday pics");
      albumPhoto(fake, chatId, "g-1", p2!);
      albumPhoto(fake, chatId, "g-1", p3!, "which is best?");

      await waitFor(() => userRows(USER, chatId).length > 0);
      await Bun.sleep(80); // debounce window ×2 — a second turn would show by now
      const rows = userRows(USER, chatId);
      expect(rows).toHaveLength(1); // ONE combined turn, not three
      const text = rows[0]!.text;
      expect(text.startsWith("holiday pics\nwhich is best?")).toBe(true);
      const lines = text.match(/\[Attached file: photo\.jpg at path: [^\]]+\]/g) ?? [];
      expect(lines).toHaveLength(3);
      // Every photo landed on disk with its own bytes.
      const paths = lines.map((l) => /at path: ([^\]]+)\]/.exec(l)![1]!);
      expect(new Set(paths).size).toBe(3);
      expect(paths.map((p) => readFileSync(p, "utf-8")).sort()).toEqual(
        [p1, p2, p3].map((id) => `bytes-of-${id}`).sort(),
      );
    } finally {
      adapter.stop();
    }
  });

  test("a non-album message interleaved during buffering is not swallowed", async () => {
    const USER = freshUser();
    const dispatched: string[] = [];
    const { fake, adapter } = startAdapter({
      userId: USER,
      mediaGroup: { debounceMs: 40, maxWaitMs: 500 },
      startTurn: ({ prompt }) => {
        dispatched.push(prompt);
        return `query-${dispatched.length}`;
      },
    });
    const chatId = freshChat();
    try {
      const [p1, p2] = servePhotos(`inter-${RUN}`, 2);
      albumPhoto(fake, chatId, "g-2", p1!, "album start");
      fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: "regular question" });
      albumPhoto(fake, chatId, "g-2", p2!);

      await waitFor(() => userRows(USER, chatId).length >= 2);
      const texts = userRows(USER, chatId).map((r) => r.text);
      expect(texts.some((t) => t === "regular question")).toBe(true);
      const album = texts.find((t) => t.startsWith("album start"))!;
      expect(album.match(/\[Attached file:/g)).toHaveLength(2);
      expect(userRows(USER, chatId)).toHaveLength(2);
      await waitFor(() => dispatched.length === 2);
      expect(dispatched[0]?.startsWith("album start")).toBe(true);
      expect(dispatched[1]).toBe("regular question");
    } finally {
      adapter.stop();
    }
  });

  test("two different groups buffer independently", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({
      userId: USER,
      mediaGroup: { debounceMs: 30, maxWaitMs: 500 },
    });
    const chatId = freshChat();
    try {
      const [a1, a2] = servePhotos(`grpA-${RUN}`, 2);
      const [b1] = servePhotos(`grpB-${RUN}`, 1);
      albumPhoto(fake, chatId, "g-A", a1!, "group A");
      albumPhoto(fake, chatId, "g-B", b1!, "group B");
      albumPhoto(fake, chatId, "g-A", a2!);

      await waitFor(() => userRows(USER, chatId).length >= 2);
      const texts = userRows(USER, chatId).map((r) => r.text);
      const groupA = texts.find((t) => t.startsWith("group A"))!;
      const groupB = texts.find((t) => t.startsWith("group B"))!;
      expect(groupA.match(/\[Attached file:/g)).toHaveLength(2);
      expect(groupB.match(/\[Attached file:/g)).toHaveLength(1);
      expect(texts).toHaveLength(2);
    } finally {
      adapter.stop();
    }
  });

  test("debounce override controls the flush timing; maxWaitMs caps a trickling group", async () => {
    const USER = freshUser();
    // Debounce longer than the cap: items every 60ms would keep resetting a
    // pure debounce forever — the cap must force the flush at ~150ms.
    const { fake, adapter } = startAdapter({
      userId: USER,
      mediaGroup: { debounceMs: 5_000, maxWaitMs: 150 },
    });
    const chatId = freshChat();
    try {
      const [c1, c2, c3] = servePhotos(`cap-${RUN}`, 3);
      albumPhoto(fake, chatId, "g-C", c1!, "trickle");
      await Bun.sleep(60);
      albumPhoto(fake, chatId, "g-C", c2!);
      expect(userRows(USER, chatId)).toHaveLength(0); // still buffering (5s debounce)
      await Bun.sleep(60);
      albumPhoto(fake, chatId, "g-C", c3!);

      // Flush must arrive around the 150ms cap, nowhere near the 5s debounce.
      await waitFor(() => userRows(USER, chatId).length > 0, 1_000);
      const rows = userRows(USER, chatId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text.match(/\[Attached file:/g)).toHaveLength(3);
    } finally {
      adapter.stop();
    }
  });
});

describe("turn footer", () => {
  test("does not append a final-turn footer to a pre-tool segment without usage", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER, footer: true });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("intermediate-footer-room"));
      const topic = getTopicByNameForUser(room("intermediate-footer-room"), USER)!;
      const message = aiMessage(topic.id, "checking the repository", {
        queryId: "intermediate-footer-query",
        agentType: "codex",
        model: "gpt-5.6-luna",
      });

      runtimeBus().broadcastMessage(topic.id, message);
      await waitFor(() => fake.callsFor(chatId).some((call) => call.text === message.text));

      expect(fake.callsFor(chatId).filter((call) => call.text.includes(message.text))).toEqual([
        expect.objectContaining({ text: message.text }),
      ]);
    } finally {
      adapter.stop();
    }
  });

  test("footer: true appends core's agent · model · tokens line as italic HTML", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER, footer: true });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("footer-room"));
      const topic = getTopicByNameForUser(room("footer-room"), USER)!;
      runtimeBus().broadcastMessage(
        topic.id,
        aiMessage(topic.id, "the answer", {
          agentType: "claude",
          model: "sonnet",
          usage: { input: 10, output: 5 },
        }),
      );
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text.startsWith("the answer")));
      const call = fake.callsFor(chatId).at(-1)!;
      expect(call.text).toBe("the answer\n\n<i>claude · sonnet · ↑10 ↓5 tok</i>");
    } finally {
      adapter.stop();
    }
  });

  test("footer default off leaves replies untouched", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("nofooter-room"));
      const topic = getTopicByNameForUser(room("nofooter-room"), USER)!;
      runtimeBus().broadcastMessage(
        topic.id,
        aiMessage(topic.id, "plain answer", { agentType: "claude", model: "sonnet" }),
      );
      await waitFor(() => fake.callsFor(chatId).some((c) => c.text === "plain answer"));
    } finally {
      adapter.stop();
    }
  });

  test("late tool-only usage edits the existing answer with its footer", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER, footer: true });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("late-footer-room"));
      const topic = getTopicByNameForUser(room("late-footer-room"), USER)!;
      const message = aiMessage(topic.id, "status before final tool", {
        queryId: "late-footer-query",
        agentType: "codex",
        model: "gpt-5.6-luna",
      });
      runtimeBus().broadcastMessage(topic.id, message);
      await waitFor(() => fake.callsFor(chatId).some((call) => call.text.startsWith(message.text)));

      runtimeBus().broadcastMessageUpdated(topic.id, message.id, {
        usage: { input: 12, output: 3 },
      });

      await waitFor(() => fake.editCalls.length === 1);
      expect(fake.editCalls[0]).toEqual({
        text: "status before final tool\n\n<i>codex · gpt-5.6-luna · ↑12 ↓3 tok</i>",
        opts: {
          chat_id: chatId,
          message_id: expect.any(Number),
          parse_mode: "HTML",
        },
      });
    } finally {
      adapter.stop();
    }
  });

  test("retries a transient footer edit without sending a duplicate footer message", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER, footer: true });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("footer-edit-retry-room"));
      const topic = getTopicByNameForUser(room("footer-edit-retry-room"), USER)!;
      const message = aiMessage(topic.id, "answer before usage", {
        queryId: "footer-edit-retry-query",
        agentType: "codex",
        model: "gpt-5.6-luna",
      });
      runtimeBus().broadcastMessage(topic.id, message);
      await waitFor(() => fake.callsFor(chatId).some((call) => call.text === message.text));
      const sendsBeforePatch = fake.callsFor(chatId).length;
      const timeout = Object.assign(new Error("edit timed out"), { code: "ETIMEDOUT" });
      fake.failNextEdits = { count: 1, error: timeout };

      runtimeBus().broadcastMessageUpdated(topic.id, message.id, {
        usage: { input: 12, output: 3 },
      });

      await waitFor(() => fake.editCalls.length === 2);
      expect(fake.callsFor(chatId)).toHaveLength(sendsBeforePatch);
      expect(fake.editCalls[1]?.text).toBe(
        "answer before usage\n\n<i>codex · gpt-5.6-luna · ↑12 ↓3 tok</i>",
      );
    } finally {
      adapter.stop();
    }
  });

  test("drops delivery state when its topic is deleted", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER, footer: true });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("footer-deleted-topic-room"));
      const topic = getTopicByNameForUser(room("footer-deleted-topic-room"), USER)!;
      const message = aiMessage(topic.id, "answer before deletion", {
        queryId: "footer-deleted-topic-query",
        agentType: "codex",
        model: "gpt-5.6-luna",
      });
      runtimeBus().broadcastMessage(topic.id, message);
      await waitFor(() => fake.callsFor(chatId).some((call) => call.text === message.text));

      runtimeBus().broadcastTopicDeleted(topic.id);
      await waitFor(() => fake.deletedMessageCalls.length === 1);
      runtimeBus().broadcastMessageUpdated(topic.id, message.id, {
        usage: { input: 5, output: 2 },
      });
      await Bun.sleep(20);

      expect(fake.editCalls).toEqual([]);
    } finally {
      adapter.stop();
    }
  });

  test("a supersede tombstone deletes the already-sent Telegram message", async () => {
    const USER = freshUser();
    const { fake, adapter } = startAdapter({ userId: USER });
    const chatId = freshChat();
    try {
      await mapChat(fake, chatId, room("supersede-delete-room"));
      const topic = getTopicByNameForUser(room("supersede-delete-room"), USER)!;
      const message = aiMessage(topic.id, "obsolete status", {
        queryId: "superseded-query",
      });
      runtimeBus().broadcastMessage(topic.id, message);
      await waitFor(() => fake.callsFor(chatId).some((call) => call.text === message.text));

      runtimeBus().broadcastMessageUpdated(topic.id, message.id, {
        deleted: true,
        text: "",
      });

      await waitFor(() => fake.deletedMessageCalls.length === 1);
      expect(fake.deletedMessageCalls[0]).toEqual({
        chatId,
        messageId: expect.any(Number),
      });
    } finally {
      adapter.stop();
    }
  });
});
