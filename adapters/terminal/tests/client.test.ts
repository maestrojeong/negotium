import { afterEach, expect, test } from "bun:test";
import { NODE_CONTROL_BASE_PATH } from "@negotium/node";
import { RemoteNegotiumClient } from "@/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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

test("remote privacy changes use the authenticated topic control boundary", async () => {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      typeof input === "string"
        ? new Request(input, init)
        : input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
    requests.push(request);
    return Response.json({ ok: true, accessMode: "shared", result: "Topic is public." });
  }) as unknown as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://127.0.0.1:43210",
    token: "node-token",
  });
  const result = await client.setAccessMode(
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
    "shared",
  );

  expect(result).toBe("Topic is public.");
  expect(requests[0]?.url).toBe(
    `http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}/topics/topic%2Fwith%20slash/access-mode`,
  );
  expect(requests[0]?.method).toBe("POST");
  expect(await requests[0]?.json()).toEqual({ userId: "remote-user", accessMode: "shared" });
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
