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
  }) as typeof fetch;

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

test("remote Vault commands reject plaintext transport to non-loopback hosts", async () => {
  let requested = false;
  globalThis.fetch = (async () => {
    requested = true;
    return Response.json({ ok: true });
  }) as typeof fetch;

  const client = new RemoteNegotiumClient({
    userId: "remote-user",
    baseUrl: "http://node.example.test:43210",
    token: "node-token",
  });

  await expect(client.runVaultCommand("/vault set REMOTE_TOKEN secret-value")).rejects.toThrow(
    "Vault commands require HTTPS or loopback HTTP",
  );
  expect(requested).toBe(false);
});
