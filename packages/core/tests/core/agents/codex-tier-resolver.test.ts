import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CODEX_VERSION } from "#agents/codex-native-multi-agent";
import {
  CODEX_TIER_FALLBACKS,
  codexTiersFromCache,
  resolveCodexTierModel,
} from "#agents/codex-tier-resolver";
import { resolveWorkerDefaultModel, SELECTABLE_MODELS } from "#agents/model-catalog";

const tempDir = mkdtempSync(join(tmpdir(), "negotium-codex-tiers-"));
const cachePath = join(tempDir, "models.json");
const originalCachePath = process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE;

function writeModels(models: unknown[]): void {
  writeFileSync(cachePath, JSON.stringify({ client_version: BUNDLED_CODEX_VERSION, models }));
}

afterEach(() => {
  if (originalCachePath === undefined) delete process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE;
  else process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE = originalCachePath;
});

test("selects the lowest-priority listed model in each suffix tier", () => {
  const selected = codexTiersFromCache({
    models: [
      { slug: "gpt-6-astra", visibility: "list", priority: 2 },
      { slug: "gpt-6-sol", visibility: "list", priority: 3 },
      { slug: "gpt-6-luna", visibility: "list", priority: 4 },
      { slug: "gpt-reserve", visibility: "hide", priority: 1 },
      { slug: "gpt-5.6-sol", visibility: "list", priority: 5 },
      { slug: "gpt-5.6-terra", visibility: "list", priority: 8 },
      { slug: "gpt-5.6-luna", visibility: "list", priority: 9 },
      { slug: "gpt-5.5", visibility: "list", priority: 13 },
    ],
  });
  expect(selected).toEqual({
    astra: "gpt-6-astra",
    sol: "gpt-6-sol",
    luna: "gpt-6-luna",
    terra: "gpt-5.6-terra",
  });
});

test("falls back for a tier with no listed entries", () => {
  writeModels([{ slug: "gpt-9-terra", visibility: "hide", priority: 1 }]);
  expect(resolveCodexTierModel("terra", cachePath)).toBe(CODEX_TIER_FALLBACKS.terra);
});

test("falls back when the cache is missing or malformed", () => {
  expect(resolveCodexTierModel("sol", join(tempDir, "missing.json"))).toBe(
    CODEX_TIER_FALLBACKS.sol,
  );
  writeFileSync(cachePath, "{");
  expect(resolveCodexTierModel("luna", cachePath)).toBe(CODEX_TIER_FALLBACKS.luna);
});

test("uses a single listed entry for its tier", () => {
  writeModels([{ slug: "gpt-7-terra", visibility: "list", priority: 10 }]);
  expect(resolveCodexTierModel("terra", cachePath)).toBe("gpt-7-terra");
});

test("catalog entries and worker default pick up a refreshed cache", () => {
  process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE = cachePath;
  writeModels([
    { slug: "gpt-7-astra", visibility: "list", priority: 2 },
    { slug: "gpt-7-sol", visibility: "list", priority: 3 },
    { slug: "gpt-7-luna", visibility: "list", priority: 4 },
    { slug: "gpt-7-terra", visibility: "list", priority: 5 },
  ]);
  expect(SELECTABLE_MODELS.slice(0, 4).map(({ model }) => model)).toEqual([
    "gpt-7-astra",
    "gpt-7-sol",
    "gpt-7-luna",
    "gpt-7-terra",
  ]);
  expect(resolveWorkerDefaultModel("codex", { defaultModel: "gpt-7-luna" })).toBe("gpt-7-terra");

  writeModels([{ slug: "gpt-8-terra", visibility: "list", priority: 1 }]);
  expect(SELECTABLE_MODELS[3]?.model).toBe("gpt-8-terra");
  expect(resolveWorkerDefaultModel("codex", { defaultModel: "gpt-7-luna" })).toBe("gpt-8-terra");
  expect(resolveWorkerDefaultModel("claude", { defaultModel: "sonnet" })).toBe("sonnet");
});

test("catalog falls back when cache content is invalid", () => {
  process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE = cachePath;
  writeFileSync(cachePath, "{");
  expect(SELECTABLE_MODELS.slice(0, 4).map(({ model }) => model)).toEqual(
    Object.values(CODEX_TIER_FALLBACKS),
  );
  expect(resolveWorkerDefaultModel("codex", { defaultModel: "gpt-6-luna" })).toBe(
    CODEX_TIER_FALLBACKS.terra,
  );
});

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
