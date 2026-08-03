import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeRegistry } from "#agents/claude-registry";
import { codexRegistry } from "#agents/codex-registry";
import { maestroRegistry } from "#agents/maestro-registry";
import { resolveCompactionExecution } from "#agents/model-catalog";
import {
  codexAuthFilePath,
  FALLBACK_MODEL,
  GATEWAY_MODEL,
  MODEL_OPUS,
  resolveDefaultModel,
  SESSION_MODEL,
  TSX_BIN,
  TSX_LOADER,
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
  test("pins compact workers to the intended model and medium effort", () => {
    expect(resolveCompactionExecution("claude", claudeRegistry)).toEqual({
      model: "claude-sonnet-5",
      effort: "medium",
    });
    expect(resolveCompactionExecution("codex", codexRegistry)).toEqual({
      model: "gpt-5.6-terra",
      effort: "medium",
    });
    expect(resolveCompactionExecution("maestro", maestroRegistry)).toEqual({
      model: "deepseek-v4-pro",
      effort: "medium",
    });
  });

  test("maps the Claude opus alias to Opus 5", () => {
    expect(MODEL_OPUS).toBe("claude-opus-5");
    expect(claudeRegistry.expandModelAlias("opus")).toBe("claude-opus-5");
  });

  test("tsx executable resolves across hoisted workspace installs", () => {
    expect(existsSync(TSX_BIN)).toBe(true);
    expect(existsSync(TSX_LOADER)).toBe(true);
  });

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

describe("session communication defaults", () => {
  test("allows tell chains up to depth 20 while preserving the environment override", async () => {
    const snapshot = snapshotEnv(["MAX_TELL_DEPTH"]);
    try {
      delete process.env.MAX_TELL_DEPTH;
      const defaults = await import(
        `../../src/platform/config.ts?tell-depth-default-${Date.now()}-${Math.random()}`
      );
      expect(defaults.MAX_TELL_DEPTH).toBe(20);

      process.env.MAX_TELL_DEPTH = "7";
      const overridden = await import(
        `../../src/platform/config.ts?tell-depth-override-${Date.now()}-${Math.random()}`
      );
      expect(overridden.MAX_TELL_DEPTH).toBe(7);

      process.env.MAX_TELL_DEPTH = "invalid";
      const invalid = await import(
        `../../src/platform/config.ts?tell-depth-invalid-${Date.now()}-${Math.random()}`
      );
      expect(invalid.MAX_TELL_DEPTH).toBe(20);
    } finally {
      restoreEnv(snapshot);
    }
  });
});

describe("Codex state root", () => {
  test("keeps auth under CODEX_HOME unless the hosted auth override wins", () => {
    const snapshot = snapshotEnv(["CODEX_HOME", "NEGOTIUM_CODEX_AUTH_FILE"]);
    try {
      process.env.CODEX_HOME = "/tmp/negotium-codex-home";
      delete process.env.NEGOTIUM_CODEX_AUTH_FILE;
      expect(codexAuthFilePath()).toBe(join("/tmp/negotium-codex-home", "auth.json"));

      process.env.NEGOTIUM_CODEX_AUTH_FILE = "/tmp/hosted-codex/auth.json";
      expect(codexAuthFilePath()).toBe("/tmp/hosted-codex/auth.json");

      delete process.env.CODEX_HOME;
      delete process.env.NEGOTIUM_CODEX_AUTH_FILE;
      expect(codexAuthFilePath()).toBe(join(homedir(), ".codex", "auth.json"));
    } finally {
      restoreEnv(snapshot);
    }
  });
});
