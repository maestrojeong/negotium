import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  referencesRuntimeSecretStorage,
  shouldSubstituteVaultToolInput,
} from "#agents/vault-tool-policy";
import { DATA_DIR } from "#platform/config";
import { Database } from "#storage/sqlite";
import {
  configureVaultStorage,
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
  test("supports an embedding host data directory and master key", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "negotium-vault-host-"));
    const restore = configureVaultStorage({
      dataDir,
      masterKey: "host-owned-test-key",
    });
    try {
      vaultSet("embedded-user", "HOST_TOKEN", "embedded-secret");
      expect(vaultGetValue("embedded-user", "HOST_TOKEN")).toBe("embedded-secret");
      const database = new Database(join(dataDir, "vault", "vault.db"), {
        readonly: true,
      });
      try {
        const row = database
          .prepare("SELECT value FROM vault WHERE user_id = ? AND key = ?")
          .get("embedded-user", "HOST_TOKEN") as { value: string };
        expect(row.value).not.toContain("embedded-secret");
        expect(() => decryptVaultValue("embedded-user", "HOST_TOKEN", row.value)).toThrow();
        expect(
          decryptVaultValue("embedded-user", "HOST_TOKEN", row.value, "host-owned-test-key").value,
        ).toBe("embedded-secret");
      } finally {
        database.close();
      }
    } finally {
      restore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

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
    const db = new Database(join(DATA_DIR, "vault", "vault.db"), { readonly: true });
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
  });

  test("blocks runtime secret storage paths at any tool-input depth", () => {
    expect(
      referencesRuntimeSecretStorage({
        nested: { file_path: "/tmp/state/vault-master-key" },
      }),
    ).toBe(true);
    expect(
      referencesRuntimeSecretStorage({
        command: "cat .otium/runtime-mcp-secret",
      }),
    ).toBe(true);
    expect(referencesRuntimeSecretStorage({ file_path: "/tmp/ordinary.txt" })).toBe(false);
  });

  test("uses a default-deny allowlist for direct tool-input substitution", () => {
    expect(shouldSubstituteVaultToolInput("Bash")).toBe(true);
    expect(shouldSubstituteVaultToolInput("WebFetch")).toBe(true);
    expect(shouldSubstituteVaultToolInput("browser_fill")).toBe(true);
    expect(shouldSubstituteVaultToolInput("mcp__playwright__browser_fill")).toBe(true);

    for (const toolName of [
      "tell_session",
      "mcp__session_comm__ask_session",
      "task_create",
      "wiki_query",
      "write_log",
      "Write",
      "Edit",
      "mcp__vault__vault_list",
    ]) {
      expect(shouldSubstituteVaultToolInput(toolName)).toBe(false);
    }
  });
});
