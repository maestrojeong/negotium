import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserVaultBrokerHandle,
  createBrowserVaultBroker,
} from "#platform/playwright/vault-broker";
import { Database } from "#storage/sqlite";
import { configureVaultStorage, vaultDel, vaultSet } from "#storage/vault";
import { encryptVaultValue } from "#storage/vault-crypto";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function request(
  broker: BrowserVaultBrokerHandle,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    const socket = connect(broker.socketPath);
    let pending = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      resolveResponse(JSON.parse(pending.slice(0, newline)) as Record<string, unknown>);
    });
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ ...body, token: broker.token })}\n`),
    );
  });
}

async function setup(
  userId: string,
): Promise<{ broker: BrowserVaultBrokerHandle; dataDir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "negotium-vault-broker-test-"));
  const dispose = configureVaultStorage({
    dataDir: dir,
    masterKey: "broker-test-master-key",
  });
  const broker = await createBrowserVaultBroker(userId);
  cleanups.push(async () => {
    await broker.close();
    dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return { broker, dataDir: dir };
}

describe("browser Vault broker", () => {
  test("uses a private socket and rejects a bad token", async () => {
    const { broker } = await setup("broker-auth-user");
    expect(statSync(broker.socketPath).mode & 0o777).toBe(0o600);
    const result = await new Promise<Record<string, unknown>>((resolveResponse) => {
      const socket = connect(broker.socketPath);
      socket.setEncoding("utf8");
      socket.once("connect", () =>
        socket.write(`${JSON.stringify({ id: 1, token: "bad", op: "transform_input" })}\n`),
      );
      socket.once("data", (chunk: string) => {
        socket.end();
        resolveResponse(JSON.parse(chunk.trim()) as Record<string, unknown>);
      });
    });
    expect(result).toMatchObject({ id: 1, ok: false, error: "unauthorized" });
  });

  test("substitutes, retains rotated secrets, redacts, then bounds output", async () => {
    const userId = "broker-redaction-user";
    const { broker, dataDir } = await setup(userId);
    const secret = "secret+/ broker?value=old";
    vaultSet(userId, "TOKEN", secret);
    vaultSet(userId, "DAMAGED", "unreadable secret");
    const database = new Database(join(dataDir, "vault", "vault.db"));
    database
      .prepare("UPDATE vault SET value = ? WHERE user_id = ? AND key = ?")
      .run(
        encryptVaultValue(userId, "DAMAGED", "unreadable secret", "wrong-master-key"),
        userId,
        "DAMAGED",
      );
    database.close();
    const transformed = await request(broker, {
      id: 1,
      op: "transform_input",
      tool: "browser_snapshot",
      value: { value: "{{TOKEN}}", maxLength: 40 },
    });
    expect(transformed.ok).toBe(true);
    expect((transformed.value as Record<string, unknown>).value).toBe(secret);
    expect((transformed.value as Record<string, unknown>).maxLength).toBe(Number.MAX_SAFE_INTEGER);

    vaultSet(userId, "TOKEN", "replacement secret");
    vaultDel(userId, "TOKEN");
    const redacted = await request(broker, {
      id: 2,
      op: "redact_output",
      lease: transformed.lease,
      boundary: { field: "snapshot", limit: 1_000_000 },
      value: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              snapshot: `prefix ${encodeURIComponent(secret)} suffix`,
            }),
          },
        ],
      },
    });
    expect(redacted.ok).toBe(true);
    const serialized = JSON.stringify(redacted.value);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
    expect(serialized).toContain("[REDACTED:TOKEN]");
    const content = (redacted.value as { content: Array<{ text: string }> }).content[0];
    expect(JSON.parse(content.text).snapshot.length).toBeLessThanOrEqual(40);
  });

  test("rejects lease replay", async () => {
    const { broker } = await setup("broker-lease-user");
    const transformed = await request(broker, {
      id: 1,
      op: "transform_input",
      tool: "browser_navigate",
      value: { url: "https://example.com" },
    });
    const body = {
      op: "redact_output",
      lease: transformed.lease,
      value: { content: [] },
    };
    expect((await request(broker, { id: 2, ...body })).ok).toBe(true);
    expect(await request(broker, { id: 3, ...body })).toMatchObject({
      ok: false,
      error: "invalid lease",
    });
  });

  test("raises maxLength and redacts+truncates the plain-text browser_iframe_read result", async () => {
    // browser_iframe_read (browser-rs 0.1.17) returns a raw string, not
    // `{content: ...}` JSON, so redaction/truncation goes through
    // `redactTextEntry`'s non-JSON fallback path instead of the field-aware one.
    const userId = "broker-iframe-read-user";
    const { broker } = await setup(userId);
    const secret = "iframe-secret-value";
    vaultSet(userId, "TOKEN", secret);

    const transformed = await request(broker, {
      id: 1,
      op: "transform_input",
      tool: "browser_iframe_read",
      value: { page: "p1", frame_selector: "#f", maxLength: 40 },
    });
    expect(transformed.ok).toBe(true);
    expect((transformed.value as Record<string, unknown>).maxLength).toBe(Number.MAX_SAFE_INTEGER);

    const longText = `prefix ${secret} ${"x".repeat(100)} suffix`;
    const redacted = await request(broker, {
      id: 2,
      op: "redact_output",
      lease: transformed.lease,
      boundary: { field: "content", limit: 40 },
      value: { content: [{ type: "text", text: longText }] },
    });
    expect(redacted.ok).toBe(true);
    const content = (redacted.value as { content: Array<{ text: string }> }).content[0];
    expect(content.text).not.toContain(secret);
    expect(content.text.length).toBeLessThanOrEqual(40 + "\n[truncated]".length);
    expect(content.text).toContain("[truncated]");
  });
});
