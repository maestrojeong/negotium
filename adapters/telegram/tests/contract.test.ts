import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAdapterStopIsIdempotent,
  assertNegotiumAdapterDefinition,
  assertNegotiumAdapterHandle,
} from "@negotium/adapter-testkit";
import { startTelegramAdapter, telegramAdapter } from "@/index";
import { FakeTelegramClient } from "./fake-client";

test("telegram implements the shared adapter lifecycle", async () => {
  assertNegotiumAdapterDefinition(telegramAdapter, "telegram");
  const dir = mkdtempSync(join(tmpdir(), "negotium-telegram-contract-"));
  const handle = startTelegramAdapter({
    startTurn: () => null,
    client: new FakeTelegramClient(),
    mappingDbPath: join(dir, "mapping.db"),
  });
  assertNegotiumAdapterHandle(handle, "telegram");
  expect(handle.name).toBe("telegram");
  await assertAdapterStopIsIdempotent(handle);
});
