import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getApiMessage, registerTopic, runtimeBus, submitUserMessage } from "@negotium/core";

test("submitUserMessage persists and publishes before starting the AI turn", () => {
  const userId = `submit-user-${randomUUID()}`;
  const topic = registerTopic({
    title: `Submit user message ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  const observed: string[] = [];
  let publishedMessageId: string | undefined;
  const unsubscribe = runtimeBus().subscribe((event) => {
    if (event.type === "message" && event.topicId === topic.id) {
      observed.push("published");
      publishedMessageId = (event.payload as { id: string }).id;
    }
  });

  try {
    const result = submitUserMessage({
      topic,
      userId,
      text: "one shared submission flow",
      sourceAdapter: "telegram",
      visualTools: false,
      fileDeliveryTools: true,
      startTurn: ({ prompt, visualTools, fileDeliveryTools }) => {
        expect(publishedMessageId).toBeString();
        expect(getApiMessage(topic.id, publishedMessageId!)).not.toBeNull();
        expect(observed).toEqual(["published"]);
        expect(prompt).toBe("one shared submission flow");
        expect(visualTools).toBe(false);
        expect(fileDeliveryTools).toBe(true);
        return "query-shared";
      },
    });

    expect(result.queryId).toBe("query-shared");
    expect(getApiMessage(topic.id, result.message.id)).toMatchObject(result.message);
    expect(getApiMessage(topic.id, result.message.id)?.sourceAdapter).toBe("telegram");
  } finally {
    unsubscribe();
  }
});

test("submitUserMessage keeps the submitted message when turn dispatch is rejected", () => {
  const userId = `submit-rejected-${randomUUID()}`;
  const topic = registerTopic({
    title: `Rejected user message ${randomUUID()}`,
    userId,
    agent: "codex",
  });

  const result = submitUserMessage({
    topic,
    userId,
    text: "keep this even without a turn",
    startTurn: () => null,
  });

  expect(result.queryId).toBeNull();
  expect(getApiMessage(topic.id, result.message.id)?.text).toBe("keep this even without a turn");
});
