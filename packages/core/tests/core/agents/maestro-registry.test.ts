import { describe, expect, test } from "bun:test";
import { maestroRegistry } from "#agents/maestro-registry";

describe("maestroRegistry model policy", () => {
  test("accepts Kimi models and aliases", () => {
    for (const model of ["kimi", "kimi-pro", "kimi-k3", "kimi-code", "kimi-k2.7-code"]) {
      expect(maestroRegistry.validateModel(model)).toBe(true);
    }
  });

  test("rejects retired DeepSeek Flash aliases", () => {
    for (const model of ["deepseek", "deepseek-flash", "deepseek-v4-flash"]) {
      expect(maestroRegistry.validateModel(model)).toBe(false);
    }
    expect(maestroRegistry.validateModel("deepseek-pro")).toBe(true);
  });
});
