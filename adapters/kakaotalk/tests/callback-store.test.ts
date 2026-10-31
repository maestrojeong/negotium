import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCallbackStore } from "@/callback-store";

describe("callback store", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function freshStore() {
    dir = mkdtempSync(join(tmpdir(), "negotium-kakaotalk-callback-"));
    return openCallbackStore(join(dir, "callbacks.db"));
  }

  test("takeLatest returns null when nothing has been stored for a topic", () => {
    const store = freshStore();
    try {
      expect(store.takeLatest("topic-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a stored callback round-trips through takeLatest", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-1",
        topicId: "topic-1",
        callbackUrl: "https://example.com/callback",
        expiresAt: Date.now() + 60_000,
      });
      const pending = store.takeLatest("topic-1");
      expect(pending?.callbackUrl).toBe("https://example.com/callback");
      expect(pending?.topicId).toBe("topic-1");
    } finally {
      store.close();
    }
  });

  test("a callback can only be consumed once (send_kakaotalk's 'only works once' contract)", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-1",
        topicId: "topic-1",
        callbackUrl: "https://example.com/callback",
        expiresAt: Date.now() + 60_000,
      });
      expect(store.takeLatest("topic-1")).not.toBeNull();
      expect(store.takeLatest("topic-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("an expired callback is not returned", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-1",
        topicId: "topic-1",
        callbackUrl: "https://example.com/callback",
        expiresAt: Date.now() - 1,
      });
      expect(store.takeLatest("topic-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("a later trigger's callback wins over a slow earlier one (decision #3: a slow turn can't consume a newer trigger's callback)", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-old",
        topicId: "topic-1",
        callbackUrl: "https://example.com/old",
        expiresAt: Date.now() + 10_000,
      });
      store.put({
        requestId: "req-new",
        topicId: "topic-1",
        callbackUrl: "https://example.com/new",
        expiresAt: Date.now() + 60_000,
      });
      const pending = store.takeLatest("topic-1");
      expect(pending?.callbackUrl).toBe("https://example.com/new");
    } finally {
      store.close();
    }
  });

  test("callbacks for different topics do not leak into each other", () => {
    const store = freshStore();
    try {
      store.put({
        requestId: "req-a",
        topicId: "topic-a",
        callbackUrl: "https://example.com/a",
        expiresAt: Date.now() + 60_000,
      });
      expect(store.takeLatest("topic-b")).toBeNull();
      expect(store.takeLatest("topic-a")?.callbackUrl).toBe("https://example.com/a");
    } finally {
      store.close();
    }
  });
});
