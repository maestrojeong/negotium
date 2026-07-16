import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

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

  test("does not expose the deprecated SSE message injection surface", async () => {
    const baseUrl = `http://127.0.0.1:${port}`;
    const sse = await fetch(
      `${baseUrl}/sse?owner=topic%3Avictim&capability=${encodeURIComponent(capability)}`,
    );
    expect(sse.status).toBe(404);
    await sse.body?.cancel();

    const messages = await fetch(
      `${baseUrl}/messages?sessionId=victim&capability=${encodeURIComponent(capability)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
      },
    );
    expect(messages.status).toBe(404);
    await messages.body?.cancel();
  });

  test("rejects capabilities and owners supplied through URL queries", async () => {
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

    const ownerCapability = createHmac("sha256", capability).update("topic:victim").digest("hex");
    const ownerInQuery = await fetch(`http://127.0.0.1:${port}/mcp?owner=topic%3Avictim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Browser-Capability": ownerCapability,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(ownerInQuery.status).toBe(400);
    await ownerInQuery.body?.cancel();
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
});
