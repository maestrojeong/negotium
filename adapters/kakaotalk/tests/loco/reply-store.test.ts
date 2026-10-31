import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocoReplyStore } from "@/loco/reply-store";

describe("LOCO reply-target store", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "negotium-kakaotalk-loco-reply-"));
    return openLocoReplyStore(join(dir, "replies.db"));
  }

  test("takeLatest returns null when nothing has been stored for a topic", () => {
    const store = freshStore();
    try {
      expect(store.takeLatest("topic-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a stored target round-trips through takeLatest", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-1",
        topicId: "topic-1",
        chatId: 12345,
        expiresAt: Date.now() + 60_000,
      });
      const pending = store.takeLatest("topic-1");
      expect(pending?.chatId).toBe(12345);
      expect(pending?.topicId).toBe("topic-1");
    } finally {
      store.close();
    }
  });

  test("a target can only be consumed once (send_kakaotalk's 'once per trigger' contract)", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-1",
        topicId: "topic-1",
        chatId: 1,
        expiresAt: Date.now() + 60_000,
      });
      expect(store.takeLatest("topic-1")).not.toBeNull();
      expect(store.takeLatest("topic-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("an expired target is not returned", () => {
    const store = freshStore();
    try {
      store.put({ requestId: "req-1", topicId: "topic-1", chatId: 1, expiresAt: Date.now() - 1 });
      expect(store.takeLatest("topic-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a later trigger's target wins over a slow earlier one", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-old",
        topicId: "topic-1",
        chatId: 111,
        expiresAt: Date.now() + 10_000,
      });
      store.put({
        requestId: "req-new",
        topicId: "topic-1",
        chatId: 222,
        expiresAt: Date.now() + 60_000,
      });
      expect(store.takeLatest("topic-1")?.chatId).toBe(222);
    } finally {
      store.close();
    }
  });

  test("targets for different topics do not leak into each other", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-a",
        topicId: "topic-a",
        chatId: 1,
        expiresAt: Date.now() + 60_000,
      });
      expect(store.takeLatest("topic-b")).toBeNull();
      expect(store.takeLatest("topic-a")?.chatId).toBe(1);
    } finally {
      store.close();
    }
  });
});
