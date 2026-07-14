import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { rotateTopicLogs } from "#agents/topic-cleanup";
import { WORKSPACE_DIR } from "#platform/config";
import {
  appendConversationEventStrict,
  getConversationPath,
  readConversation,
} from "#storage/conversations";

const TEST_USER_ID = 7_700_002;
const TOPIC = "cron-rotation";

function reset(): void {
  rmSync(dirname(getConversationPath(TEST_USER_ID, TOPIC)), {
    recursive: true,
    force: true,
  });
}

beforeEach(reset);
afterEach(reset);

describe("rotateTopicLogs", () => {
  test("retains only the requested tail of complete turns", async () => {
    for (let i = 1; i <= 7; i++) {
      appendConversationEventStrict(TEST_USER_ID, TOPIC, "maestro", {
        type: "user_message",
        content: `prompt-${i}`,
      });
      appendConversationEventStrict(TEST_USER_ID, TOPIC, "maestro", {
        type: "result",
        content: `answer-${i}`,
        stopReason: "end_turn",
      });
    }

    const result = await rotateTopicLogs({
      userId: TEST_USER_ID,
      topicName: TOPIC,
      cwd: WORKSPACE_DIR,
      retainTurns: 5,
    });

    expect(result).toMatchObject({ rotated: true, totalTurns: 7, retainedTurns: 5 });
    const entries = readConversation(TEST_USER_ID, TOPIC);
    expect(
      entries
        .filter((entry) => entry.event.type === "user_message")
        .map((entry) => (entry.event.type === "user_message" ? entry.event.content : null)),
    ).toEqual(["prompt-3", "prompt-4", "prompt-5", "prompt-6", "prompt-7"]);
    expect(entries.some((entry) => entry.event.type === "session")).toBe(false);
  });
});
