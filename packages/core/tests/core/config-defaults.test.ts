import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeRegistry } from "#agents/claude-registry";
import { codexRegistry } from "#agents/codex-registry";
import { maestroRegistry } from "#agents/maestro-registry";
import { resolveCompactionExecution, resolveDefaultModel } from "#agents/model-catalog";
import {
  codexAuthFilePath,
  FALLBACK_MODEL,
  MODEL_OPUS,
  TSX_BIN,
  TSX_LOADER,
} from "#platform/config";

const MODEL_ENV_KEYS = ["DEFAULT_AGENT", "DEFAULT_MODEL", "FALLBACK_AGENT", "FALLBACK_MODEL"];

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

function resolveDefaultModelWithEnv(
  agent: "claude" | "codex" | "maestro",
  env: Record<string, string | undefined>,
): string {
  const modelCatalogPath = resolve(import.meta.dir, "../../src/agents/model-catalog.ts");
  const registryPath = resolve(import.meta.dir, "../../src/agents/registry.ts");
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { resolveDefaultModel } = await import(${JSON.stringify(modelCatalogPath)});
       const { getRegistry } = await import(${JSON.stringify(registryPath)});
       process.stdout.write(resolveDefaultModel(${JSON.stringify(agent)}, getRegistry(${JSON.stringify(agent)})));`,
    ],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  return new TextDecoder().decode(child.stdout);
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
    expect(resolveDefaultModel("claude", claudeRegistry)).toBe("sonnet");
  });

  test("rejects a cross-agent fallback model", () => {
    expect(
      resolveDefaultModelWithEnv("codex", {
        FALLBACK_AGENT: "codex",
        FALLBACK_MODEL: "sonnet",
      }),
    ).toBe(codexRegistry.defaultModel);
  });

  test("rejects an invalid model for the fallback agent", () => {
    expect(
      resolveDefaultModelWithEnv("claude", {
        FALLBACK_AGENT: "claude",
        FALLBACK_MODEL: "not-a-claude-model",
      }),
    ).toBe(claudeRegistry.defaultModel);
  });

  test("honors a valid model for the fallback agent", () => {
    expect(
      resolveDefaultModelWithEnv("claude", {
        FALLBACK_AGENT: "claude",
        FALLBACK_MODEL: "opus",
      }),
    ).toBe("opus");
  });

  test("unset agent env defaults the whole node to claude", async () => {
    const snapshot = snapshotEnv(MODEL_ENV_KEYS);
    try {
      delete process.env.FALLBACK_AGENT;
      delete process.env.DEFAULT_AGENT;

      const config = await import(
        `../../src/platform/config.ts?agent-default-${Date.now()}-${Math.random()}`
      );

      expect(config.FALLBACK_AGENT).toBe("claude");
    } finally {
      restoreEnv(snapshot);
    }
  });

  test("legacy DEFAULT_* env aliases feed the node-wide model default", async () => {
    const snapshot = snapshotEnv(MODEL_ENV_KEYS);
    try {
      delete process.env.FALLBACK_AGENT;
      delete process.env.FALLBACK_MODEL;
      process.env.DEFAULT_AGENT = "codex";
      process.env.DEFAULT_MODEL = "gpt-env";

      const config = await import(
        `../../src/platform/config.ts?env-defaults-${Date.now()}-${Math.random()}`
      );

      expect(config.FALLBACK_AGENT).toBe("codex");
      expect(config.FALLBACK_MODEL).toBe("gpt-env");
      expect(
        resolveDefaultModelWithEnv("codex", {
          FALLBACK_AGENT: "",
          FALLBACK_MODEL: "",
          DEFAULT_AGENT: "codex",
          DEFAULT_MODEL: "gpt-env",
        }),
      ).toBe("gpt-env");
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
