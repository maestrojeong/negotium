import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendConversationEventStrict,
  cloneConversationLog,
  getActiveConversationPath,
  getConversationPath,
  readConversation,
  readRawConversation,
  replaceConversationStrict,
} from "#storage/conversations";

const TEST_USER_ID = 7_700_001;

function conversationUserDir(): string {
  return dirname(getConversationPath(TEST_USER_ID, "__cleanup__"));
}

function reset(): void {
  rmSync(conversationUserDir(), { recursive: true, force: true });
}

beforeEach(reset);
afterEach(reset);

function seedEntries(topic: string, count: number): void {
  for (let i = 0; i < count; i++) {
    appendConversationEventStrict(TEST_USER_ID, topic, "maestro", {
      type: "user_message",
      content: `m${i}`,
    });
  }
}

describe("cloneConversationLog", () => {
  test("keeps raw history immutable while appending new events to active context", () => {
    seedEntries("parent", 2);
    const rawBefore = readRawConversation(TEST_USER_ID, "parent");
    replaceConversationStrict(TEST_USER_ID, "parent", [
      {
        ts: new Date().toISOString(),
        agent: "maestro",
        event: {
          type: "user_message",
          synthetic: "compaction",
          content: "compacted context",
        },
      },
    ]);

    appendConversationEventStrict(TEST_USER_ID, "parent", "maestro", {
      type: "result",
      content: "post-compact reply",
      stopReason: "end_turn",
    });

    expect(readRawConversation(TEST_USER_ID, "parent").slice(0, 2)).toEqual(rawBefore);
    expect(readRawConversation(TEST_USER_ID, "parent").length).toBe(3);
    expect(readConversation(TEST_USER_ID, "parent").length).toBe(2);
    expect(existsSync(getActiveConversationPath(TEST_USER_ID, "parent"))).toBe(true);
  });

  test("copies parent entries into the child path verbatim", () => {
    seedEntries("parent", 5);
    const result = cloneConversationLog({
      userId: TEST_USER_ID,
      srcTopic: "parent",
      dstTopic: "child",
    });

    expect(result.copied).toBe(true);
    expect(result.entries).toBe(5);

    const childEntries = readConversation(TEST_USER_ID, "child");
    expect(childEntries.length).toBe(5);
    expect(childEntries.every((e) => e.event.type === "user_message")).toBe(true);
    expect(
      childEntries.map((e) => (e.event.type === "user_message" ? e.event.content : null)),
    ).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  test("copies both raw history and an existing active projection", () => {
    seedEntries("parent", 3);
    replaceConversationStrict(TEST_USER_ID, "parent", [
      {
        ts: new Date().toISOString(),
        agent: "maestro",
        event: { type: "result", content: "compact summary", stopReason: "end_turn" },
      },
    ]);

    const result = cloneConversationLog({
      userId: TEST_USER_ID,
      srcTopic: "parent",
      dstTopic: "child",
    });

    expect(result).toEqual({ copied: true, entries: 3 });
    expect(readRawConversation(TEST_USER_ID, "child").length).toBe(3);
    expect(readConversation(TEST_USER_ID, "child")).toEqual(
      readConversation(TEST_USER_ID, "parent"),
    );
  });

  test("returns copied:false when the parent log is empty", () => {
    const result = cloneConversationLog({
      userId: TEST_USER_ID,
      srcTopic: "nonexistent",
      dstTopic: "child",
    });
    expect(result.copied).toBe(false);
    expect(result.entries).toBe(0);
    expect(existsSync(getConversationPath(TEST_USER_ID, "child"))).toBe(false);
  });

  test("refuses to overwrite a non-empty destination", () => {
    seedEntries("parent", 3);
    seedEntries("child", 1);

    const result = cloneConversationLog({
      userId: TEST_USER_ID,
      srcTopic: "parent",
      dstTopic: "child",
    });
    expect(result.copied).toBe(false);
    expect(result.entries).toBe(0);
    expect(readConversation(TEST_USER_ID, "child").length).toBe(1);
  });
});
