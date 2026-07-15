import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { contextUsageRatio, nextUsageAlert } from "#runtime/usage-alert";

describe("context usage alerts", () => {
  test("does not mistake aggregate turn spend for current context occupancy", () => {
    const usage = {
      inputTokens: 1_343_881,
      outputTokens: 4_698,
      cacheReadInputTokens: 1_230_336,
      contextTokens: 104_464,
      contextWindow: 258_400,
    };

    expect(contextUsageRatio(usage)).toBeCloseTo(0.404, 3);
    expect(nextUsageAlert("user", randomUUID(), "dev", usage)).toBeNull();
  });

  test("warns from provider-reported context occupancy", () => {
    const alert = nextUsageAlert("user", randomUUID(), "dev", {
      inputTokens: 90_000,
      outputTokens: 1_000,
      contextTokens: 85_000,
      contextWindow: 100_000,
    });

    expect(alert).toContain("85%");
    expect(alert).toContain("85K / 100K");
  });
});
