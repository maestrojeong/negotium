import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getApiMessage, listApiMessages, NODE_CONTROL_TOKEN, topicService } from "@negotium/core";
import { NODE_CONTROL_BASE_PATH, NODE_RUNTIME_CONTRACT_BASE_PATH } from "@negotium/node";
import { EmbeddedNegotiumClient, RemoteNegotiumClient } from "@/client";
import { getRuntimeUserTurnRequest } from "../../../packages/core/src/storage/runtime-turn-requests";
import { createNodeControlHandler } from "../../../packages/node/src/control";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("remote topic usage uses the authenticated node control boundary", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
    requests.push(request);
    return Response.json({
      ok: true,
      usage: {
        topicId: "topic/id",
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 40,
        queries: 1,
        estimatedCostUsd: 0.01,
      },
    });
  }) as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://127.0.0.1:43210",
    token: "node-token",
  });

  expect(await client.listTopicUsage("topic/id")).toMatchObject({
    topicId: "topic/id",
    inputTokens: 10,
    cacheReadInputTokens: 40,
  });
  expect(requests[0]?.url).toBe(
    `http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}/topics/topic%2Fid/usage?user=remote-user`,
  );
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer node-token");
});

test("remote background sessions always request the node-wide (allUsers) view", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
    requests.push(request);
    return Response.json({ ok: true, sessions: [] });
  }) as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://127.0.0.1:43210",
    token: "node-token",
  });

  expect(await client.listBackgroundSessions()).toEqual([]);
  expect(requests[0]?.url).toBe(
    `http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}/background-sessions?user=remote-user&allUsers=true`,
  );
});

test("remote Vault commands use the authenticated node control boundary", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
    requests.push(request);
    return Response.json({ ok: true, result: "Stored REMOTE_TOKEN." });
  }) as unknown as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://127.0.0.1:43210",
    token: "node-token",
  });
  const secret = "do-not-return-this";
  const result = await client.runVaultCommand(`/vault set REMOTE_TOKEN ${secret}`);

  expect(result).toBe("Stored REMOTE_TOKEN.");
  expect(result).not.toContain(secret);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}/vault/command`);
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer node-token");
  expect(await requests[0]?.json()).toEqual({
    userId: "remote-user",
    commandLine: `/vault set REMOTE_TOKEN ${secret}`,
  });
});

test("remote Vault settings use structured endpoints without parsing command output", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
    requests.push(request);
    if (request.method === "GET") {
      return Response.json({ ok: true, entries: [{ key: "API_TOKEN", description: "primary" }] });
    }
    if (request.method === "DELETE") return Response.json({ ok: true, deleted: true });
    return Response.json({ ok: true, result: { key: "API_TOKEN", updated: false } });
  }) as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://127.0.0.1:43210",
    token: "node-token",
  });
  const secret = "value | with spaces";

  expect(await client.listVaultEntries()).toEqual([{ key: "API_TOKEN", description: "primary" }]);
  expect(await client.saveVaultEntry("API_TOKEN", secret, "primary")).toEqual({
    key: "API_TOKEN",
    updated: false,
  });
  expect(await client.deleteVaultEntry("API_TOKEN")).toBe(true);

  expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "DELETE"]);
  expect(await requests[1]?.json()).toEqual({
    userId: "remote-user",
    key: "API_TOKEN",
    value: secret,
    description: "primary",
  });
});

test("remote Vault settings remain compatible with a node that only has the command endpoint", async () => {
  const commandLines: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
    if (!request.url.endsWith("/vault/command")) {
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    const body = (await request.json()) as { commandLine: string };
    commandLines.push(body.commandLine);
    if (body.commandLine === "/vault list") {
      return Response.json({ ok: true, result: "Vault keys (1):\n- LEGACY_TOKEN: old node" });
    }
    if (body.commandLine.startsWith("/vault set")) {
      return Response.json({ ok: true, result: "Stored LEGACY_TOKEN." });
    }
    return Response.json({ ok: true, result: "Deleted LEGACY_TOKEN." });
  }) as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://127.0.0.1:43210",
    token: "node-token",
  });

  expect(await client.listVaultEntries()).toEqual([
    { key: "LEGACY_TOKEN", description: "old node" },
  ]);
  expect(await client.saveVaultEntry("LEGACY_TOKEN", "value with spaces", "old node")).toEqual({
    key: "LEGACY_TOKEN",
    updated: false,
  });
  expect(await client.deleteVaultEntry("LEGACY_TOKEN")).toBe(true);
  expect(commandLines).toContain("/vault set LEGACY_TOKEN value with spaces | old node");

  await client.saveVaultEntry("LEGACY_TOKEN", "value with spaces", "");
  expect(commandLines).toContain("/vault set LEGACY_TOKEN value with spaces | ");
});

test("remote effort changes use the authenticated topic control boundary", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
    requests.push(request);
    return Response.json({ ok: true, effort: "high", result: "Effort set to 'high'." });
  }) as unknown as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://127.0.0.1:43210",
    token: "node-token",
  });
  const result = await client.setEffort(
    {
      id: "topic/with slash",
      title: "Topic",
      kind: "agent",
      agent: "codex",
      defaultModel: "gpt-5.6-luna",
      defaultEffort: "medium",
      participants: [{ userId: "remote-user", role: "owner" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
    },
    "high",
  );

  expect(result).toBe("Effort set to 'high'.");
  expect(requests[0]?.url).toBe(
    `http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}/topics/topic%2Fwith%20slash/effort`,
  );
  expect(requests[0]?.method).toBe("POST");
  expect(await requests[0]?.json()).toEqual({ userId: "remote-user", effort: "high" });
});

test("remote control rejects plaintext transport to non-loopback hosts before any request", () => {
  let requested = false;
  globalThis.fetch = (async () => {
    requested = true;
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;

  expect(
    () =>
      new RemoteNegotiumClient({
        userId: "remote-user",
        baseUrl: "http://node.example.test:43210",
        token: "node-token",
      }),
  ).toThrow("Remote node control requires HTTPS or loopback HTTP");
  expect(requested).toBe(false);
});

test("remote control permits HTTPS and loopback HTTP origins", () => {
  for (const baseUrl of [
    "https://node.example.test",
    "http://localhost:43210",
    "http://127.0.0.2:43210",
    "http://[::1]:43210",
  ]) {
    expect(
      () => new RemoteNegotiumClient({ userId: "remote-user", baseUrl, token: "node-token" }),
    ).not.toThrow();
  }
});

test("remote Terminal retries an ambiguous real Gateway submission with one stable identity", async () => {
  const userId = `terminal-remote-${randomUUID()}`;
  const topic = topicService.create({
    title: `Terminal remote ${randomUUID()}`,
    userId,
    kind: "agent",
  });
  const handler = createNodeControlHandler({
    port: () => 6370,
    startedAt: new Date().toISOString(),
    requestShutdown: () => {},
  });
  const requestUrls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let loseFirstAcknowledgement = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init);
    requestUrls.push(request.url);
    bodies.push((await request.clone().json()) as Record<string, unknown>);
    const response = await handler(request);
    if (!response) throw new Error(`Node handler did not claim ${new URL(request.url).pathname}`);
    if (loseFirstAcknowledgement) {
      loseFirstAcknowledgement = false;
      // The Node committed successfully, but the local client never received
      // the response. Its retry must reuse the exact same idempotency key.
      throw new TypeError("simulated connection reset after commit");
    }
    return response;
  }) as typeof fetch;
  const client = new RemoteNegotiumClient({
    userId,
    baseUrl: "http://127.0.0.1:6370",
    token: NODE_CONTROL_TOKEN,
  });

  try {
    const message = await client.sendMessage(topic, "exactly once from Terminal");
    expect(requestUrls).toHaveLength(2);
    expect(
      requestUrls.every(
        (url) => new URL(url).pathname === `${NODE_RUNTIME_CONTRACT_BASE_PATH}/turns`,
      ),
    ).toBe(true);
    expect(bodies[0]?.clientMessageId).toBe(bodies[1]?.clientMessageId);
    expect(bodies[0]?.requestId).toBe(bodies[0]?.clientMessageId);
    expect(bodies[0]?.sourceAdapter).toBe("terminal");
    expect(String(bodies[0]?.clientMessageId)).toStartWith("terminal:");
    expect(message).toMatchObject({
      topicId: topic.id,
      authorId: userId,
      sourceAdapter: "terminal",
      sourceMessageId: bodies[0]?.clientMessageId,
      text: "exactly once from Terminal",
    });
    const persisted = listApiMessages(topic.id, { limit: 20 }).page.filter(
      (candidate) => candidate.sourceMessageId === bodies[0]?.clientMessageId,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe(message.id);
  } finally {
    await topicService.delete({ topicId: topic.id, userId });
  }
});

test("embedded Terminal uses the same canonical durable identity boundary in process", async () => {
  const userId = `terminal-embedded-${randomUUID()}`;
  const topic = topicService.create({
    title: `Terminal embedded ${randomUUID()}`,
    userId,
    kind: "agent",
  });
  const client = new EmbeddedNegotiumClient({ userId, startNode: false });

  try {
    const message = client.sendMessage(topic, "embedded durable turn");
    expect(message.sourceAdapter).toBe("terminal");
    expect(message.sourceMessageId).toStartWith("terminal:");
    expect(getApiMessage(topic.id, message.id)).toMatchObject({
      id: message.id,
      sourceAdapter: "terminal",
      sourceMessageId: message.sourceMessageId,
      text: "embedded durable turn",
    });
    expect(getRuntimeUserTurnRequest(topic.id)?.requestId).toBe(message.sourceMessageId);
  } finally {
    await client.stop();
    await topicService.delete({ topicId: topic.id, userId });
  }
});

test("remote Terminal reconstructs the canonical message for an older v1 Gateway ACK", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init);
    const body = (await request.json()) as { topicId: string; clientMessageId: string };
    return Response.json(
      {
        ok: true,
        v: 1,
        accepted: true,
        deduplicated: false,
        requestId: body.clientMessageId,
        clientMessageId: body.clientMessageId,
        topicId: body.topicId,
        messageId: "old-node-message",
        cursor: 12,
      },
      { status: 202 },
    );
  }) as typeof fetch;
  const client = new RemoteNegotiumClient({
    userId: "old-node-user",
    baseUrl: "http://127.0.0.1:6370",
    token: "old-node-token",
  });
  const topic = {
    id: "old-node-topic",
    title: "Old node",
    kind: "agent" as const,
    agent: "codex" as const,
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium" as const,
    participants: [{ userId: "old-node-user", role: "owner" as const }],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  };

  const message = await client.sendMessage(topic, "mixed-version fallback");
  expect(message).toMatchObject({
    id: "old-node-message",
    topicId: topic.id,
    authorId: "old-node-user",
    sourceAdapter: "terminal",
    text: "mixed-version fallback",
  });
  expect(message.sourceMessageId).toStartWith("terminal:");
});
