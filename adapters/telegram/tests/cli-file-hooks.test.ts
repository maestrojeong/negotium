import { expect, test } from "bun:test";
import { fileHooks, resetFileHooks } from "@negotium/core";
import { nodeFileStore } from "@negotium/node";
import { installTelegramNodeFileHooks } from "@/cli";

test("Telegram CLI installs the canonical node upload resolver", () => {
  resetFileHooks();
  try {
    installTelegramNodeFileHooks();
    expect(fileHooks()).toBe(nodeFileStore.hooks);
  } finally {
    resetFileHooks();
  }
});
