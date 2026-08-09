import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbortReason, getTopicByNameForUser } from "@negotium/core";
import { startTelegramAdapter } from "@/index";
import { streamAgentEvents } from "../../../packages/core/src/runtime/turn-runner";
import { deleteTopic } from "../../../packages/core/src/storage/api-topics";
import type { UnifiedEvent } from "../../../packages/core/src/types";
import { FakeTelegramClient, waitFor } from "./fake-client";

test("delivers streamed Maestro text once when completed text follows its tool calls", async () => {
  const userId = `telegram-stream-${randomUUID()}`;
  const chatId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const title = `stream-duplication-${randomUUID()}`;
  const fake = new FakeTelegramClient();
  const adapter = startTelegramAdapter({
    client: fake,
    userId,
    startTurn: () => null,
    mappingDbPath: join(mkdtempSync(join(tmpdir(), "telegram-stream-")), "mappings.db"),
  });

  try {
    fake.emit({ chat: { id: chatId }, from: { id: 1 }, text: `/new ${title}` });
    await waitFor(() => fake.callsFor(chatId).some((call) => call.text.includes(title)));
    const topic = getTopicByNameForUser(title, userId);
    expect(topic).not.toBeNull();
    const sendsBeforeTurn = fake.callsFor(chatId).length;
    const queryId = randomUUID();

    async function* maestroEvents(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text_delta", content: "first status" };
      yield { type: "tool_use", name: "Bash", input: {}, toolUseId: "tool-1" };
      yield { type: "text", content: "first status" };
      yield { type: "tool_result", toolUseId: "tool-1", content: "done" };
      yield { type: "tool_use", name: "Bash", input: {}, toolUseId: "tool-2" };
      yield { type: "tool_result", toolUseId: "tool-2", content: "done" };
      yield { type: "text_delta", content: "second status" };
      yield { type: "tool_use", name: "Read", input: {}, toolUseId: "tool-3" };
      yield { type: "text", content: "second status" };
      yield { type: "tool_result", toolUseId: "tool-3", content: "done" };
      yield { type: "text_delta", content: "final answer" };
      yield { type: "tool_use", name: "Read", input: {}, toolUseId: "tool-4" };
      yield { type: "text", content: "final answer" };
      yield { type: "tool_result", toolUseId: "tool-4", content: "done" };
      yield { type: "result", content: "final answer", stopReason: "end_turn" };
    }

    await streamAgentEvents(
      topic!.id,
      title,
      queryId,
      maestroEvents(),
      {
        topicId: topic!.id,
        queryId,
        origin: "user",
        prompt: "test",
        abortController: new AbortController(),
        abortReason: AbortReason.None,
      },
      "maestro",
      "deepseek-pro",
      "medium",
      userId,
    );

    await waitFor(() => fake.callsFor(chatId).length >= sendsBeforeTurn + 3);
    expect(
      fake
        .callsFor(chatId)
        .slice(sendsBeforeTurn)
        .map((call) => call.text)
        .filter((text) => !text.startsWith("🔧")),
    ).toEqual(["first status", "second status", "final answer"]);
  } finally {
    adapter.stop();
    const topic = getTopicByNameForUser(title, userId);
    if (topic) deleteTopic(topic.id);
  }
});
