import { describe, expect, test } from "bun:test";
import {
  buildContextWarningText,
  claudeRequestContextTokens,
  clearContextWarning,
  contextUsageRatio,
  createContextWarningState,
  DEFAULT_CONTEXT_WARNING_RATIO,
  nextContextWarning,
  shouldWarnForContext,
} from "#runtime/public-helpers";

describe("public context warning policy", () => {
  test("calculates latest-request occupancy and applies the shared 80% threshold", () => {
    expect(DEFAULT_CONTEXT_WARNING_RATIO).toBe(0.8);
    expect(contextUsageRatio({ contextTokens: 79_999, contextWindow: 100_000 })).toBeCloseTo(
      0.79999,
    );
    expect(shouldWarnForContext({ contextTokens: 79_999, contextWindow: 100_000 })).toBeFalse();
    expect(shouldWarnForContext({ contextTokens: 80_000, contextWindow: 100_000 })).toBeTrue();
    expect(contextUsageRatio({ contextTokens: -1, contextWindow: 100_000 })).toBeNull();
    expect(contextUsageRatio({ contextTokens: 1, contextWindow: 0 })).toBeNull();
  });

  test("adapts command guidance without duplicating the warning copy", () => {
    const common = {
      topicTitle: "dev",
      usage: { contextTokens: 85_000, contextWindow: 100_000 },
    };
    const negotium = buildContextWarningText({ ...common, supportsCompact: true });
    const legacyOtium = buildContextWarningText({ ...common, supportsCompact: false });

    expect(negotium).toContain('"dev" context가 85%');
    expect(negotium).toContain("/compact");
    expect(negotium).toContain("/new");
    expect(legacyOtium).toContain('"dev" context가 85%');
    expect(legacyOtium).not.toContain("/compact");
    expect(legacyOtium).toContain("/new");
  });

  test("dedupes and clears only inside caller-owned state", () => {
    const firstRuntime = createContextWarningState();
    const secondRuntime = createContextWarningState();
    const options = {
      key: "user:topic",
      topicTitle: "dev",
      usage: { contextTokens: 90, contextWindow: 100 },
    };

    expect(nextContextWarning(firstRuntime, options)).not.toBeNull();
    expect(nextContextWarning(firstRuntime, options)).toBeNull();
    expect(nextContextWarning(secondRuntime, options)).not.toBeNull();
    clearContextWarning(firstRuntime, options.key);
    expect(nextContextWarning(firstRuntime, options)).not.toBeNull();
  });

  test("calculates Claude latest-request context without SDK type coupling", () => {
    expect(
      claudeRequestContextTokens({
        input_tokens: 1_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 30_000,
        output_tokens: 500,
      }),
    ).toBe(33_500);
    expect(claudeRequestContextTokens({})).toBeNull();
    expect(claudeRequestContextTokens({ input_tokens: -1 })).toBeNull();
  });
});
