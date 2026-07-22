import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const capability = "wrapper-security-test-capability";
let port = 0;
let processHandle: ReturnType<typeof Bun.spawn> | undefined;

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function waitUntilReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The child may still be loading its MCP dependencies.
    }
    await Bun.sleep(25);
  }
  throw new Error("browser HTTP wrapper did not become ready");
}

describe("authenticated browser HTTP wrapper", () => {
  beforeAll(async () => {
    port = await allocatePort();
    const script = resolve(import.meta.dir, "../../../scripts/mcp-patchright-http.mjs");
    processHandle = Bun.spawn(["node", script, "--host", "127.0.0.1", "--port", String(port)], {
      env: { ...process.env, NEGOTIUM_BROWSER_CAPABILITY: capability },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitUntilReady(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    processHandle?.kill("SIGTERM");
    await processHandle?.exited;
  });

  test("reports the active browser engine behind the authenticated gateway", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const health = (await response.json()) as { name?: string; backend?: string };
    expect(health.name).toBe("negotium-browser-gateway");
    expect(health.backend).toBe(
      process.env.NEGOTIUM_BROWSER_RS_BIN ? "browser-rs" : "mcp-patchright",
    );
  });

  test("exposes SSE only with owner-scoped header authentication", async () => {
    const baseUrl = `http://127.0.0.1:${port}`;
    const ownerCapability = createHmac("sha256", capability).update("topic:victim").digest("hex");

    const unauthenticated = await fetch(`${baseUrl}/sse`, {
      headers: { "X-Browser-Owner": "topic:victim" },
    });
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.body?.cancel();

    const controller = new AbortController();
    const sse = await fetch(`${baseUrl}/sse`, {
      headers: {
        "X-Browser-Owner": "topic:victim",
        "X-Browser-Capability": ownerCapability,
      },
      signal: controller.signal,
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
    await sse.body?.cancel().catch(() => undefined);

    const messages = await fetch(`${baseUrl}/message?sessionId=victim&token=wrong`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    });
    expect(messages.status).toBe(404);
    await messages.body?.cancel();
  });

  test("completes an SSE handshake with signed header auth", async () => {
    const owner = "topic:maestro";
    const ownerCapability = createHmac("sha256", capability).update(owner).digest("hex");
    const query = new URLSearchParams({ owner });
    const authenticatedFetch = (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("X-Browser-Capability", ownerCapability);
      return fetch(input, { ...init, headers });
    };
    const client = new Client({ name: "sse-wrapper-test", version: "1.0.0" });
    const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse?${query}`), {
      eventSourceInit: { fetch: authenticatedFetch },
      requestInit: { headers: { "X-Browser-Capability": ownerCapability } },
    });

    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.tools.some((tool) => tool.name === "browser_status")).toBe(true);
    const status = await client.callTool({ name: "browser_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    await client.close();
  });

  test("keeps Maestro browser credentials out of URLs through the stdio bridge", async () => {
    const owner = "topic:마에스트로";
    const ownerCapability = createHmac("sha256", capability).update(owner).digest("hex");
    const query = new URLSearchParams({ owner });
    const proxy = resolve(import.meta.dir, "../../../src/mcp/browser-sse-proxy-server.ts");
    const client = new Client({ name: "maestro-browser-proxy-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", proxy],
      env: {
        PATH: process.env.PATH ?? "",
        NEGOTIUM_BROWSER_SSE_URL: `http://127.0.0.1:${port}/sse?${query}`,
        NEGOTIUM_BROWSER_OWNER_CAPABILITY: ownerCapability,
      },
      stderr: "pipe",
    });

    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.some((tool) => tool.name === "browser_status")).toBe(true);
    await client.close();
  });

  test("rejects owner capabilities supplied through SSE URL queries", async () => {
    const owner = "topic:query-leak";
    const ownerCapability = createHmac("sha256", capability).update(owner).digest("hex");
    const query = new URLSearchParams({ owner, capability: ownerCapability });
    const response = await fetch(`http://127.0.0.1:${port}/sse?${query}`);
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  test("rejects capabilities supplied through URL queries", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/mcp?owner=topic%3Avictim&capability=${encodeURIComponent(capability)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Browser-Owner": "topic:victim",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      },
    );
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  test("accepts a Unicode owner in the authenticated HTTP URL", async () => {
    const owner = "topic:한국어 브라우저";
    const ownerCapability = createHmac("sha256", capability).update(owner).digest("hex");
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    url.searchParams.set("owner", owner);
    const client = new Client({ name: "http-wrapper-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "X-Browser-Capability": ownerCapability } },
    });

    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);
    await client.close();
  });

  test("rejects a capability derived for a different browser owner", async () => {
    const otherOwnerCapability = createHmac("sha256", capability)
      .update("topic:other")
      .digest("hex");
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Browser-Owner": "topic:victim",
        "X-Browser-Capability": otherOwnerCapability,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });

  test("cleans up a Unicode owner through the authenticated gateway", async () => {
    const owner = "topic:정리할 브라우저";
    const query = new URLSearchParams({ owner });
    const response = await fetch(`http://127.0.0.1:${port}/owners?${query}`, {
      method: "DELETE",
      headers: {
        "X-Browser-Capability": capability,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, owner, closed: 0 });
  });
});
