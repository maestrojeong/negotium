import { describe, expect, test } from "bun:test";
import {
  parseRuntimeGatewaySse,
  RUNTIME_GATEWAY_CONTROL_PATH,
  RuntimeGatewayClient,
} from "../../src/runtime-gateway";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function requestFrom(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
}

describe("RuntimeGatewayClient", () => {
  test("uses the versioned control path and keeps credentials in the header", async () => {
    let request: Request | undefined;
    const client = new RuntimeGatewayClient({
      baseUrl: "http://127.0.0.1:7777",
      token: "secret",
      fetch: async (input, init) => {
        request = requestFrom(input, init);
        return json({ ok: true, v: 1, capabilities: [], cursor: 4 });
      },
    });

    await client.health();
    expect(request?.url).toBe(`http://127.0.0.1:7777${RUNTIME_GATEWAY_CONTROL_PATH}/health`);
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    expect(request?.url).not.toContain("secret");
  });

  test("accepts a caller-defined relay prefix and short-lived token provider", async () => {
    let request: Request | undefined;
    const client = new RuntimeGatewayClient({
      baseUrl: "https://relay.example/cell",
      pathPrefix: "/api/v1/peer/runtime",
      token: async () => "peer-token",
      fetch: async (input, init) => {
        request = requestFrom(input, init);
        return json(
          {
            ok: true,
            v: 1,
            accepted: true,
            deduplicated: false,
            requestId: "request-1",
            clientMessageId: "message-1",
            topicId: "topic-1",
            messageId: "stored-1",
            cursor: 8,
          },
          202,
        );
      },
    });

    await client.submitTurn({
      topicId: "topic-1",
      userId: "local",
      actorUserId: "otium-user",
      text: "hello",
      requestId: "request-1",
      clientMessageId: "message-1",
    });
    expect(request?.url).toBe("https://relay.example/cell/api/v1/peer/runtime/turns");
    expect(request?.headers.get("authorization")).toBe("Bearer peer-token");
    expect(await request?.json()).toEqual({
      v: 1,
      topicId: "topic-1",
      userId: "local",
      actorUserId: "otium-user",
      text: "hello",
      requestId: "request-1",
      clientMessageId: "message-1",
    });
  });

  test("parses resumable multi-line SSE events", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'id: 12\nevent: runtime\ndata: {"type":"text",\ndata: "value":"ok"}\n\n',
          ),
        );
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseRuntimeGatewaySse(stream)) events.push(event);
    expect(events).toEqual([{ id: 12, event: "runtime", data: { type: "text", value: "ok" } }]);
  });

  test("normalizes missing usage buckets to zero", async () => {
    const client = new RuntimeGatewayClient({
      baseUrl: "http://127.0.0.1:7777",
      token: "secret",
      fetch: async () => json({ ok: true, v: 1, usage: { queries: 3, inputTokens: 42 } }),
    });

    expect(await client.getTopicUsage("topic-1", "local")).toEqual({
      queries: 3,
      inputTokens: 42,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0,
    });
  });
});
