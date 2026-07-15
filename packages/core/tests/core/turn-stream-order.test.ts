import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RoomQueryControl } from "#query/active-rooms";
import { AbortReason } from "#query/types";
import { streamAgentEvents } from "#runtime/turn-runner";
import { listApiMessages } from "#storage/api-messages";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { latestRuntimeEventSeq, listRuntimeEventsAfter } from "#storage/runtime-events";
import type { UnifiedEvent } from "#types";

const topicIds = new Set<string>();

function seedTopic(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `stream-order-${id}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    participants: [{ userId: "owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  topicIds.add(id);
  return id;
}

async function* eventStream(): AsyncGenerator<UnifiedEvent> {
  yield { type: "text_delta", content: "first status" };
  yield { type: "text", content: "first status" };
  yield {
    type: "tool_use",
    name: "Bash",
    input: { command: "pwd" },
    toolUseId: "tool-1",
  };
  yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
  yield { type: "text_delta", content: "second status" };
  yield { type: "text", content: "second status" };
  yield {
    type: "tool_use",
    name: "Bash",
    input: { command: "git status" },
    toolUseId: "tool-2",
  };
  yield { type: "tool_result", toolUseId: "tool-2", content: "clean" };
  yield { type: "text_delta", content: "final answer" };
  yield { type: "text", content: "final answer" };
  yield {
    type: "result",
    content: "first statussecond statusfinal answer",
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 3 },
  };
}

afterEach(() => {
  for (const topicId of topicIds) deleteTopic(topicId);
  topicIds.clear();
});

describe("turn stream ordering", () => {
  test("persists assistant segments before the tools that follow them", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      eventStream(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    const timeline = listRuntimeEventsAfter(after)
      .filter((event) => event.topicId === topicId)
      .map((event) => {
        if (event.type === "message") {
          return `message:${(event.payload as { text?: string }).text ?? ""}`;
        }
        if (event.type === "ai-status") {
          const payload = event.payload as { kind?: string; toolUseId?: string };
          if (payload.kind === "tool_call") return `tool:${payload.toolUseId}`;
          if (payload.kind === "tool_output") return `output:${payload.toolUseId}`;
          if (payload.kind === "ai_done") return "done";
        }
        return null;
      })
      .filter((item): item is string => item !== null);

    expect(timeline).toEqual([
      "message:first status",
      "tool:tool-1",
      "output:tool-1",
      "message:second status",
      "tool:tool-2",
      "output:tool-2",
      "message:final answer",
      "done",
    ]);
    expect(listApiMessages(topicId).page.map((message) => message.text)).toEqual([
      "first status",
      "second status",
      "final answer",
    ]);
    expect(listApiMessages(topicId).page.at(-1)?.usage).toEqual({ input: 10, output: 3 });
  });

  test("accepts a completed-only text segment after an earlier streamed segment", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    async function* mixedTextStream(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text_delta", content: "streamed status" };
      yield { type: "text", content: "streamed status" };
      yield {
        type: "tool_use",
        name: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-1",
      };
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
      yield { type: "text", content: "completed-only answer" };
      yield {
        type: "result",
        content: "completed-only answer",
        stopReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      mixedTextStream(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    expect(listApiMessages(topicId).page.map((message) => message.text)).toEqual([
      "streamed status",
      "completed-only answer",
    ]);
  });

  test("attaches final usage to the last segment after a tool-only ending", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();
    async function* toolOnlyEnding(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text", content: "status before final tool" };
      yield {
        type: "tool_use",
        name: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-1",
      };
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
      yield {
        type: "result",
        content: "status before final tool",
        stopReason: "end_turn",
        usage: { inputTokens: 8, outputTokens: 2 },
      };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      toolOnlyEnding(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    const messages = listApiMessages(topicId).page;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: "status before final tool",
      usage: { input: 8, output: 2 },
    });
    expect(
      listRuntimeEventsAfter(after)
        .filter((event) => event.topicId === topicId && event.type === "message-updated")
        .map((event) => event.payload),
    ).toContainEqual({
      messageId: messages[0]?.id,
      patch: { usage: { input: 8, output: 2 } },
    });
  });

  test("removes already-flushed assistant segments when the turn is superseded", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();
    async function* supersededStream(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text_delta", content: "obsolete status" };
      yield { type: "text", content: "obsolete status" };
      yield {
        type: "tool_use",
        name: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-1",
      };
      control.abortReason = AbortReason.Internal;
      control.abortController.abort();
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      supersededStream(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    expect(listApiMessages(topicId).page).toEqual([]);
    expect(
      listRuntimeEventsAfter(after)
        .filter((event) => event.topicId === topicId && event.type === "message-updated")
        .map((event) => event.payload),
    ).toContainEqual({
      messageId: expect.any(String),
      patch: { deleted: true, text: "" },
    });
  });
});
