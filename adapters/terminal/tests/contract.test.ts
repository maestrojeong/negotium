import { expect, test } from "bun:test";
import {
  assertNegotiumAdapterCapability,
  assertNegotiumAdapterDefinition,
} from "@negotium/adapter-testkit";
import { terminalAdapter } from "@/index";

test("terminal implements the shared adapter definition", () => {
  assertNegotiumAdapterDefinition(terminalAdapter, "terminal");
  assertNegotiumAdapterCapability(terminalAdapter, "localUserInput", true);
  assertNegotiumAdapterCapability(terminalAdapter, "topicManagement", true);
  assertNegotiumAdapterCapability(terminalAdapter, "externalPlacedTurn", false);
  expect(terminalAdapter.apiVersion).toBe(3);
});
