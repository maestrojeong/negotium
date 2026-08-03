import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostedCodexHomePath } from "#agents/execution-host";
import { runAgent } from "#agents/index";
import { isSessionExpiredError } from "#runtime/errors";
import { resolveSessionRetry } from "#runtime/turn-runner";
import { appendConversationEventStrict, getConversationPath } from "#storage/conversations";

const conversationPaths: string[] = [];

afterEach(() => {
  for (const path of conversationPaths.splice(0)) rmSync(path, { force: true });
});

describe("provider session portability", () => {
  test("recognizes Codex canonical rollout lookup failures as repairable", () => {
    expect(
      isSessionExpiredError(
        "thread/resume failed: failed to resolve rollout path `/tmp/rollout.jsonl`: file does not exist",
      ),
    ).toBe(true);
  });

  test("failed rollout reconstruction does not silently start a fresh provider session", async () => {
    const userId = `repair-user-${randomUUID()}`;
    const topic = `repair-topic-${randomUUID()}`;
    const path = getConversationPath(userId, topic);
    conversationPaths.push(path);
    appendConversationEventStrict(userId, topic, "codex", {
      type: "user_message",
      content: "history that must not be dropped",
    });
    appendConversationEventStrict(userId, topic, "codex", {
      type: "result",
      content: "prior answer",
      stopReason: "end_turn",
    });
    mkdirSync(join(hostedCodexHomePath(), "sessions"), { recursive: true });

    const events = [];
    for await (const event of runAgent({
      agent: "codex",
      prompt: "continue",
      sessionId: randomUUID(),
      cwd: "/outside-negotium-workspace",
      systemPrompt: "system",
      userId,
      session: topic,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "error",
        content:
          "Provider session could not be rebuilt from conversation history; the existing session was preserved for retry.",
      },
    ]);
  });

  test("session-expiry recovery preserves the resume key when reconstruction fails", () => {
    const userId = `retry-user-${randomUUID()}`;
    const topic = `retry-topic-${randomUUID()}`;
    const path = getConversationPath(userId, topic);
    conversationPaths.push(path);
    appendConversationEventStrict(userId, topic, "codex", {
      type: "user_message",
      content: "history that must survive expiry",
    });
    appendConversationEventStrict(userId, topic, "codex", {
      type: "result",
      content: "prior answer",
      stopReason: "end_turn",
    });
    let reset = false;

    const retry = resolveSessionRetry({
      topicId: randomUUID(),
      topicTitle: topic,
      userId,
      agent: "codex",
      sessionId: randomUUID(),
      cwd: "/outside-negotium-workspace",
      silent: false,
      model: "gpt-5.6-luna",
      onSessionReset: () => {
        reset = true;
      },
    });

    expect(retry.kind).toBe("failed");
    expect(reset).toBe(false);
  });
});
