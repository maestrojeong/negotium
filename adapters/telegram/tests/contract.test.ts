import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNegotiumAdapterContract } from "@negotium/adapter-sdk/testkit";
import { startTelegramAdapter, telegramAdapter } from "@/index";
import { FakeTelegramClient } from "./fake-client";

test("telegram implements the shared adapter lifecycle", async () => {
  await assertNegotiumAdapterContract({
    name: "telegram",
    definition: telegramAdapter,
    capabilities: {
      localUserInput: true,
      topicManagement: true,
      externalPlacedTurn: false,
    },
    createHandle: () => {
      const dir = mkdtempSync(join(tmpdir(), "negotium-telegram-contract-"));
      return startTelegramAdapter({
        startTurn: () => null,
        client: new FakeTelegramClient(),
        mappingDbPath: join(dir, "mapping.db"),
      });
    },
  });
});
