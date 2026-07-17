import { test } from "bun:test";
import { assertNegotiumAdapterContract } from "@negotium/adapter-sdk/testkit";
import { terminalAdapter } from "@/index";

test("terminal implements the shared adapter definition", async () => {
  await assertNegotiumAdapterContract({
    name: "terminal",
    definition: terminalAdapter,
    capabilities: {
      localUserInput: true,
      topicManagement: true,
      externalPlacedTurn: false,
    },
  });
});
