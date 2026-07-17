import { describe, expect, test } from "bun:test";
import { scrubVaultSetCommandsFromHistory } from "@/commands/chat";

describe("chat Vault history", () => {
  test("removes secret-bearing Vault set commands", () => {
    const history = [
      "/vault list",
      "/vault set API_TOKEN super-secret",
      "ordinary chat message",
      "/VAULT@my_bot SET OTHER_SECRET hidden-value | description",
    ];

    scrubVaultSetCommandsFromHistory(history);

    expect(history).toEqual(["/vault list", "ordinary chat message"]);
  });

  test("preserves non-secret Vault commands and similar chat text", () => {
    const history = [
      "/vault",
      "/vault del API_TOKEN",
      "/vault setting is useful",
      "please run /vault set API_TOKEN later",
    ];

    scrubVaultSetCommandsFromHistory(history);

    expect(history).toEqual([
      "/vault",
      "/vault del API_TOKEN",
      "/vault setting is useful",
      "please run /vault set API_TOKEN later",
    ]);
  });
});
