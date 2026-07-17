import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executeVaultCommand, isVaultCommandLine } from "#application/vault-command";
import { vaultDel, vaultGetValue } from "#storage/vault";

const created: Array<{ userId: string; key: string }> = [];

afterEach(() => {
  for (const entry of created.splice(0)) vaultDel(entry.userId, entry.key);
});

describe("human-facing Vault commands", () => {
  test("stores, lists, and deletes a secret without returning its value", () => {
    const userId = `vault-command-${randomUUID()}`;
    const secret = "do-not-echo-this";
    created.push({ userId, key: "API_TOKEN" });

    expect(executeVaultCommand(userId, `/vault set api_token ${secret} API credential`)).toBe(
      "Stored API_TOKEN.",
    );
    expect(vaultGetValue(userId, "API_TOKEN")).toBe(secret);

    const list = executeVaultCommand(userId, "/vault list");
    expect(list).toContain("API_TOKEN: API credential");
    expect(list).not.toContain(secret);
    expect(executeVaultCommand(userId, "/vault del API_TOKEN")).toBe("Deleted API_TOKEN.");
    expect(vaultGetValue(userId, "API_TOKEN")).toBeUndefined();
  });

  test("supports spaces in values when a pipe separates the description", () => {
    const userId = `vault-command-${randomUUID()}`;
    created.push({ userId, key: "PASSPHRASE" });

    expect(
      executeVaultCommand(
        userId,
        "/vault@NegotiumBot set PASSPHRASE value with spaces | signing passphrase",
      ),
    ).toBe("Stored PASSPHRASE.");
    expect(vaultGetValue(userId, "PASSPHRASE")).toBe("value with spaces");
    expect(executeVaultCommand(userId, "/vault list")).toContain("PASSPHRASE: signing passphrase");
  });

  test("recognizes only the exact Vault command and never exposes a get operation", () => {
    expect(isVaultCommandLine("/vault set KEY value")).toBe(true);
    expect(isVaultCommandLine("/vault@Bot list")).toBe(true);
    expect(isVaultCommandLine("/vaulted set KEY value")).toBe(false);
    expect(executeVaultCommand("local", "/vault get KEY")).toContain("Vault commands:");
  });

  test("renders channel-neutral help and enforces Vault size limits", () => {
    const panel = executeVaultCommand(`vault-command-${randomUUID()}`, "/vault");
    expect(panel).toContain("Secret values are never displayed.");
    expect(panel).not.toContain("\x1b");
    expect(executeVaultCommand("local", "/vault set KEY abc")).toBe(
      "Vault value must be at least 4 bytes.",
    );
    expect(executeVaultCommand("local", `/vault set KEY value | ${"x".repeat(501)}`)).toBe(
      "Vault description must not exceed 500 characters.",
    );
  });
});
