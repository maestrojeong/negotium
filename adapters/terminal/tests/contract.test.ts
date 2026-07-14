import { expect, test } from "bun:test";
import { assertNegotiumAdapterDefinition } from "@negotium/adapter-testkit";
import { terminalAdapter } from "@/index";

test("terminal implements the shared adapter definition", () => {
  assertNegotiumAdapterDefinition(terminalAdapter, "terminal");
  expect(terminalAdapter.apiVersion).toBe(2);
});
