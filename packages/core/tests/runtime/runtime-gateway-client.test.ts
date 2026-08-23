import { describe, expect, test } from "bun:test";
import {
  parseRuntimeGatewaySse,
  RUNTIME_GATEWAY_CONTROL_PATH,
  RuntimeGatewayClient,
  RuntimeGatewayError,
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

  test("ensures a canonical manager topic for an external user", async () => {
    let request: Request | undefined;
    const client = new RuntimeGatewayClient({
      baseUrl: "http://127.0.0.1:7777",
      token: "secret",
      fetch: async (input, init) => {
        request = requestFrom(input, init);
        return json({
          ok: true,
          v: 1,
          topic: {
            id: "manager-1",
            title: "General",
            kind: "manager",
            agent: "maestro",
            participants: [{ userId: "otium-user", role: "owner" }],
          },
        });
      },
    });

    expect(await client.ensureManagerTopic("otium-user")).toMatchObject({
      id: "manager-1",
      kind: "manager",
    });
    expect(request?.url).toBe(`http://127.0.0.1:7777${RUNTIME_GATEWAY_CONTROL_PATH}/manager-topic`);
    expect(await request?.json()).toEqual({ v: 1, userId: "otium-user" });
  });

  test("preserves an idempotency conflict as an HTTP error", async () => {
    const client = new RuntimeGatewayClient({
      baseUrl: "http://127.0.0.1:7777",
      token: "secret",
      fetch: async () => json({ ok: false, error: "conflict" }, 409),
    });

    await expect(
      client.submitTurn({
        topicId: "topic-1",
        userId: "local",
        text: "hello",
        requestId: "stable-request",
        clientMessageId: "stable-message",
      }),
    ).rejects.toMatchObject({ kind: "http", status: 409 });
  });

  test("classifies token-provider failure as configuration, before transport", async () => {
    let contacted = false;
    const client = new RuntimeGatewayClient({
      baseUrl: "https://relay.example/cell",
      token: async () => {
        throw new Error("peer unavailable");
      },
      fetch: async () => {
        contacted = true;
        return json({});
      },
    });

    await expect(client.health()).rejects.toMatchObject({
      kind: "config",
      message: "peer unavailable",
    });
    expect(contacted).toBe(false);
  });

  test("fails a malformed SSE payload as a protocol error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
        controller.close();
      },
    });

    let error: unknown;
    try {
      for await (const _event of parseRuntimeGatewaySse(stream)) {
        // No event can be yielded from malformed data.
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeGatewayError);
    expect(error).toMatchObject({ kind: "protocol" });
  });
});
