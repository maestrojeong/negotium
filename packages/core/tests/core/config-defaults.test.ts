import { describe, expect, test } from "bun:test";
import {
  FALLBACK_MODEL,
  GATEWAY_MODEL,
  resolveDefaultModel,
  SESSION_MODEL,
} from "#platform/config";

const MODEL_ENV_KEYS = [
  "DEFAULT_AGENT",
  "DEFAULT_MODEL",
  "FALLBACK_AGENT",
  "FALLBACK_MODEL",
  "SESSION_AGENT",
  "SESSION_MODEL",
  "GATEWAY_AGENT",
  "GATEWAY_MODEL",
];

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("role default models", () => {
  test("unset model env leaves registry defaults authoritative", () => {
    expect(FALLBACK_MODEL).toBeUndefined();
    expect(SESSION_MODEL).toBeUndefined();
    expect(GATEWAY_MODEL).toBeUndefined();
    expect(resolveDefaultModel("claude", "sonnet")).toBe("sonnet");
  });

  test("legacy DEFAULT_* env aliases feed role model defaults", async () => {
    const snapshot = snapshotEnv(MODEL_ENV_KEYS);
    try {
      delete process.env.FALLBACK_AGENT;
      delete process.env.FALLBACK_MODEL;
      delete process.env.SESSION_AGENT;
      delete process.env.SESSION_MODEL;
      delete process.env.GATEWAY_AGENT;
      delete process.env.GATEWAY_MODEL;
      process.env.DEFAULT_AGENT = "codex";
      process.env.DEFAULT_MODEL = "gpt-env";

      const config = await import(
        `../../src/platform/config.ts?env-defaults-${Date.now()}-${Math.random()}`
      );

      expect(config.FALLBACK_AGENT).toBe("codex");
      expect(config.FALLBACK_MODEL).toBe("gpt-env");
      expect(config.SESSION_AGENT).toBe("codex");
      expect(config.SESSION_MODEL).toBe("gpt-env");
      expect(config.GATEWAY_AGENT).toBe("codex");
      expect(config.GATEWAY_MODEL).toBe("gpt-env");
      expect(config.resolveDefaultModel("codex", "gpt-5.6-luna")).toBe("gpt-env");
      expect(config.resolveDefaultModel("claude", "sonnet")).toBe("sonnet");
    } finally {
      restoreEnv(snapshot);
    }
  });
});
