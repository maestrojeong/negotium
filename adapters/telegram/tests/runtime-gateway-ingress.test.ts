import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getApiMessage, listApiMessages, NODE_CONTROL_TOKEN, topicService } from "@negotium/core";
import { submitTelegramTurnToNode } from "@/cli";
import { createNodeControlHandler } from "../../../packages/node/src/control";

test("Telegram retries use the real Runtime Gateway route and create one canonical message", async () => {
  const userId = `telegram-gateway-${randomUUID()}`;
  const topic = topicService.create({
    title: `Telegram gateway ${randomUUID()}`,
    userId,
    kind: "agent",
  });
  const handler = createNodeControlHandler({
    port: () => 6370,
    startedAt: new Date().toISOString(),
    requestShutdown: () => {},
  });
  const fetchRequest = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init);
    const response = await handler(request);
    if (!response) throw new Error(`Node handler did not claim ${new URL(request.url).pathname}`);
    return response;
  };
  const clientMessageId = `telegram:123:45:message:991`;
  const input = {
    topic,
    userId,
    clientMessageId,
    actorLabel: "@owner",
    text: "exactly once",
    sourceAdapter: "telegram" as const,
    visualTools: false as const,
    fileDeliveryTools: true as const,
  };

  try {
    const first = await submitTelegramTurnToNode(
      { baseUrl: "http://127.0.0.1:6370", token: NODE_CONTROL_TOKEN },
      input,
      fetchRequest,
    );
    const replay = await submitTelegramTurnToNode(
      { baseUrl: "http://127.0.0.1:6370", token: NODE_CONTROL_TOKEN },
      input,
      fetchRequest,
    );

    expect(first.queryId).toBe(clientMessageId);
    expect(replay.queryId).toBe(first.queryId);
    const messages = listApiMessages(topic.id, { limit: 20 }).page.filter(
      (message) => message.sourceMessageId === clientMessageId,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorId: userId,
      sourceAdapter: "telegram",
      sourceMessageId: clientMessageId,
      text: "exactly once",
    });
    expect(getApiMessage(topic.id, messages[0]!.id)?.id).toBe(messages[0]!.id);
  } finally {
    await topicService.delete({ topicId: topic.id, userId });
  }
});

test("Telegram retries a lost acknowledgement with the same committed identity", async () => {
  const userId = `telegram-lost-ack-${randomUUID()}`;
  const topic = topicService.create({
    title: `Telegram lost ACK ${randomUUID()}`,
    userId,
    kind: "agent",
  });
  const handler = createNodeControlHandler({
    port: () => 6370,
    startedAt: new Date().toISOString(),
    requestShutdown: () => {},
  });
  const clientMessageId = `telegram:456:main:message:992`;
  let attempts = 0;
  const fetchRequest = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init);
    attempts += 1;
    const response = await handler(request);
    if (!response) throw new Error(`Node handler did not claim ${new URL(request.url).pathname}`);
    if (attempts === 1) throw new TypeError("simulated ACK loss after commit");
    return response;
  };

  try {
    const result = await submitTelegramTurnToNode(
      { baseUrl: "http://127.0.0.1:6370", token: NODE_CONTROL_TOKEN },
      {
        topic,
        userId,
        clientMessageId,
        text: "one Telegram turn",
        sourceAdapter: "telegram",
        visualTools: false,
        fileDeliveryTools: true,
      },
      fetchRequest,
    );
    expect(result.queryId).toBe(clientMessageId);
    expect(attempts).toBe(2);
    expect(
      listApiMessages(topic.id, { limit: 20 }).page.filter(
        (message) => message.sourceMessageId === clientMessageId,
      ),
    ).toHaveLength(1);
  } finally {
    await topicService.delete({ topicId: topic.id, userId });
  }
});
