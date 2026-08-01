import { describe, expect, test } from "bun:test";
import { RUN_DIR } from "#platform/config";
import type { AgentQueryOptions } from "#types";

/**
 * The SDK only registers its `ReadToolOutput` tool when truncation is enabled
 * *with* `saveFullOutput`, so the provider's builtin list advertising
 * `"ReadToolOutput"` is only truthful while this config is on. These assert the
 * config the provider hands the SDK, which is the contract that matters.
 */
async function buildTruncationConfig(opts: AgentQueryOptions) {
  const { buildMaestroToolResultTruncation } = await import("#agents/maestro-provider");
  return buildMaestroToolResultTruncation(opts);
}

describe("maestro toolResultTruncation defaults", () => {
  test("is on by default, persists the full output, and stays inside this node's state dir", async () => {
    const config = (await buildTruncationConfig({ agent: "maestro" } as AgentQueryOptions)) as {
      enabled: boolean;
      saveFullOutput: boolean;
      outputDir: string;
      ignoreTools: string[];
    };

    expect(config.enabled).toBeTrue();
    // Without saveFullOutput the SDK truncates but keeps no copy, and never
    // registers the tool that reads one back.
    expect(config.saveFullOutput).toBeTrue();
    expect(config.outputDir.startsWith(RUN_DIR)).toBeTrue();
    // Truncating the recovery tool would make an oversized result unreadable
    // through the only tool meant to recover it.
    expect(config.ignoreTools).toContain("ReadToolOutput");
  });

  test("a caller can tune the budget", async () => {
    const config = (await buildTruncationConfig({
      agent: "maestro",
      toolResultTruncation: { enabled: true, maxBytes: 8192, saveFullOutput: true },
    } as AgentQueryOptions)) as { maxBytes: number };

    expect(config.maxBytes).toBe(8192);
  });

  test("a caller can opt out entirely", async () => {
    const config = (await buildTruncationConfig({
      agent: "maestro",
      toolResultTruncation: { enabled: false },
    } as AgentQueryOptions)) as { enabled: boolean };

    // A turn whose tool results must arrive whole must be able to say so.
    expect(config.enabled).toBeFalse();
  });
});
