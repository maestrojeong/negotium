import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { referencesRuntimeSecretStorage, shouldRedirectVaultTool } from "#agents/vault-tool-policy";
import { executeVaultHttpRequest } from "#mcp/vault-http";
import { executeVaultRun } from "#mcp/vault-run";
import { DATA_DIR } from "#platform/config";
import { Database } from "#storage/sqlite";
import {
  redactVaultSecrets,
  vaultDel,
  vaultGetValue,
  vaultSet,
  vaultSubstituteDetailed,
} from "#storage/vault";
import { decryptVaultValue, encryptVaultValue, isEncryptedVaultValue } from "#storage/vault-crypto";

const createdEntries: Array<{ userId: string; key: string }> = [];

function remember(userId: string, key: string, value: string): void {
  vaultSet(userId, key, value);
  createdEntries.push({ userId, key });
}

afterEach(() => {
  for (const entry of createdEntries.splice(0)) vaultDel(entry.userId, entry.key);
});

describe("Vault secret boundary", () => {
  test("encrypts values with row-bound authenticated encryption", () => {
    const encrypted = encryptVaultValue("user-a", "API_TOKEN", "secret-value");
    expect(isEncryptedVaultValue(encrypted)).toBe(true);
    expect(encrypted).not.toContain("secret-value");
    expect(decryptVaultValue("user-a", "API_TOKEN", encrypted)).toEqual({
      value: "secret-value",
      legacyPlaintext: false,
    });
    expect(() => decryptVaultValue("user-b", "API_TOKEN", encrypted)).toThrow();
    expect(decryptVaultValue("user-a", "API_TOKEN", "legacy-secret")).toEqual({
      value: "legacy-secret",
      legacyPlaintext: true,
    });
  });

  test("stores ciphertext while preserving the exact secret value", () => {
    const userId = `vault-storage-${randomUUID()}`;
    const value = "  leading and trailing secret  ";
    remember(userId, "EXACT_VALUE", value);

    expect(vaultGetValue(userId, "EXACT_VALUE")).toBe(value);
    const db = new Database(join(DATA_DIR, "vault.db"), { readonly: true });
    try {
      const row = db
        .prepare("SELECT value FROM vault WHERE user_id = ? AND key = ?")
        .get(userId, "EXACT_VALUE") as { value: string };
      expect(isEncryptedVaultValue(row.value)).toBe(true);
      expect(row.value).not.toContain(value);
    } finally {
      db.close();
    }
  });

  test("redacts raw, URL-encoded, base64, and base64url secret forms", () => {
    const userId = `vault-redact-${randomUUID()}`;
    const secret = "token+/with spaces";
    remember(userId, "TOKEN", secret);
    const encoded = [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
    ].join(" | ");

    const redacted = redactVaultSecrets(userId, encoded);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(Buffer.from(secret).toString("base64"));
    expect(redacted).toContain("[REDACTED:TOKEN]");
  });

  test("reports consumed keys without returning their values", () => {
    const userId = `vault-substitute-${randomUUID()}`;
    remember(userId, "TOKEN", "secret-token");
    const result = vaultSubstituteDetailed(userId, "Bearer {{token}} / {{MISSING}}");
    expect(result).toEqual({
      text: "Bearer secret-token / {{MISSING}}",
      usedKeys: ["TOKEN"],
    });
    expect(shouldRedirectVaultTool(userId, "Bash", { command: "use {{TOKEN}}" })).toBe(true);
    expect(
      shouldRedirectVaultTool(userId, "mcp__vault__vault_run", {
        command: "use {{TOKEN}}",
      }),
    ).toBe(false);
  });

  test("blocks runtime secret storage paths at any tool-input depth", () => {
    expect(
      referencesRuntimeSecretStorage({ nested: { file_path: "/tmp/state/vault-master-key" } }),
    ).toBe(true);
    expect(referencesRuntimeSecretStorage({ command: "cat .otium/runtime-mcp-secret" })).toBe(true);
    expect(referencesRuntimeSecretStorage({ file_path: "/tmp/ordinary.txt" })).toBe(false);
  });

  test("vault_run executes internally and redacts command output", async () => {
    const userId = `vault-run-${randomUUID()}`;
    const secret = "run-secret-value";
    remember(userId, "RUN_TOKEN", secret);

    const result = await executeVaultRun(userId, {
      command: "printf '%s' '{{RUN_TOKEN}}'; printf '\\n'; printf '%s' '{{RUN_TOKEN}}' | base64",
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.usedKeys).toEqual(["RUN_TOKEN"]);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain(Buffer.from(secret).toString("base64"));
    expect(result.stdout).toContain("[REDACTED:RUN_TOKEN]");
  });

  test("vault_http_request keeps expanded credentials out of its result", async () => {
    const userId = `vault-http-${randomUUID()}`;
    const secret = "http-secret-value";
    remember(userId, "HTTP_TOKEN", secret);
    let receivedAuthorization = "";
    const fetchImpl = (async (_input: Request | string | URL, init?: RequestInit) => {
      receivedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(`echo ${secret}`, {
        status: 200,
        headers: { "content-type": "text/plain", location: `https://example.com/${secret}` },
      });
    }) as typeof fetch;

    const result = await executeVaultHttpRequest(
      userId,
      {
        method: "GET",
        url: "https://api.example.com/data",
        headers: { Authorization: "Bearer {{HTTP_TOKEN}}" },
      },
      fetchImpl,
    );
    expect(receivedAuthorization).toBe(`Bearer ${secret}`);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.body).toContain("[REDACTED:HTTP_TOKEN]");
    expect(result.headers?.location).toContain("[REDACTED:HTTP_TOKEN]");
  });

  test("vault_http_request rejects plaintext transport and credentials in URLs", async () => {
    const userId = `vault-http-reject-${randomUUID()}`;
    remember(userId, "TOKEN", "secret");
    const http = await executeVaultHttpRequest(userId, {
      method: "GET",
      url: "http://example.com",
      headers: { Authorization: "Bearer {{TOKEN}}" },
    });
    const query = await executeVaultHttpRequest(userId, {
      method: "GET",
      url: "https://example.com/?token={{TOKEN}}",
    });
    expect(http.error).toContain("HTTPS");
    expect(query.error).toContain("out of URLs");
  });
});
