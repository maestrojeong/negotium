import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_CODEX_VERSION,
  bundledCodexModelCachePath,
  ensureCodexModelCache,
  writeCodexCatalogWithNativeMultiAgentDisabled,
} from "#agents/codex-native-multi-agent";

test("bootstraps a missing Codex model cache before hardening the catalog", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-bootstrap-"));
  const authPath = join(codexHome, "auth.json");
  writeFileSync(authPath, "{}", "utf8");

  let bootstrapCalls = 0;
  let isolatedHome = "";
  const resolvedCachePath = await ensureCodexModelCache(
    authPath,
    async (receivedHome, receivedCache) => {
      bootstrapCalls += 1;
      isolatedHome = receivedHome;
      expect(receivedHome).not.toBe(codexHome);
      expect(receivedCache).toBe(join(receivedHome, "models_cache.json"));
      expect(readFileSync(join(receivedHome, "auth.json"), "utf8")).toBe("{}");
      writeFileSync(
        receivedCache,
        JSON.stringify({
          client_version: BUNDLED_CODEX_VERSION,
          models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }],
        }),
        "utf8",
      );
    },
  );

  expect(bootstrapCalls).toBe(1);
  expect(isolatedHome).not.toBe("");
  expect(() => readFileSync(isolatedHome, "utf8")).toThrow();
  expect(resolvedCachePath).toBe(bundledCodexModelCachePath(authPath));
  const outputPath = writeCodexCatalogWithNativeMultiAgentDisabled(authPath, resolvedCachePath);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  expect(output.models[0].multi_agent_version).toBe("disabled");
});

test("snapshots a compatible shared cache for the bundled Codex version", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-compatible-"));
  const authPath = join(codexHome, "auth.json");
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(authPath, "{}", "utf8");
  writeFileSync(
    cachePath,
    JSON.stringify({
      client_version: BUNDLED_CODEX_VERSION,
      models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }],
    }),
    "utf8",
  );

  const resolvedCachePath = await ensureCodexModelCache(authPath, async () => {
    throw new Error("compatible cache should not bootstrap");
  });

  expect(resolvedCachePath).toBe(bundledCodexModelCachePath(authPath));
  expect(JSON.parse(readFileSync(resolvedCachePath, "utf8")).client_version).toBe(
    BUNDLED_CODEX_VERSION,
  );
});

test("refreshes the private snapshot from a newer compatible shared cache", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-compatible-refresh-"));
  const authPath = join(codexHome, "auth.json");
  const cachePath = join(codexHome, "models_cache.json");
  const bundledCachePath = bundledCodexModelCachePath(authPath);
  writeFileSync(authPath, "{}", "utf8");
  writeFileSync(
    bundledCachePath,
    JSON.stringify({
      client_version: BUNDLED_CODEX_VERSION,
      models: [{ slug: "old-model", multi_agent_version: "v2" }],
    }),
    "utf8",
  );
  writeFileSync(
    cachePath,
    JSON.stringify({
      client_version: BUNDLED_CODEX_VERSION,
      models: [{ slug: "new-model", multi_agent_version: "v2" }],
    }),
    "utf8",
  );

  const resolvedCachePath = await ensureCodexModelCache(authPath, async () => {
    throw new Error("compatible cache should not bootstrap");
  });

  expect(JSON.parse(readFileSync(resolvedCachePath, "utf8")).models[0].slug).toBe("new-model");
});

test("falls back to the private snapshot when the shared cache is malformed", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-malformed-shared-"));
  const authPath = join(codexHome, "auth.json");
  const cachePath = join(codexHome, "models_cache.json");
  const bundledCachePath = bundledCodexModelCachePath(authPath);
  writeFileSync(authPath, "{}", "utf8");
  writeFileSync(
    bundledCachePath,
    JSON.stringify({
      client_version: BUNDLED_CODEX_VERSION,
      models: [{ slug: "safe-model", multi_agent_version: "v2" }],
    }),
    "utf8",
  );
  writeFileSync(cachePath, "{", "utf8");

  const resolvedCachePath = await ensureCodexModelCache(authPath, async () => {
    throw new Error("private cache should prevent bootstrap");
  });

  expect(JSON.parse(readFileSync(resolvedCachePath, "utf8")).models[0].slug).toBe("safe-model");
});

test("rebuilds when the shared cache is malformed and no private snapshot exists", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-malformed-bootstrap-"));
  const authPath = join(codexHome, "auth.json");
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(authPath, "{}", "utf8");
  writeFileSync(cachePath, "{", "utf8");

  let bootstrapCalls = 0;
  const resolvedCachePath = await ensureCodexModelCache(authPath, async (_, receivedCache) => {
    bootstrapCalls += 1;
    writeFileSync(
      receivedCache,
      JSON.stringify({
        client_version: BUNDLED_CODEX_VERSION,
        models: [{ slug: "recovered-model", multi_agent_version: "v2" }],
      }),
      "utf8",
    );
  });

  expect(bootstrapCalls).toBe(1);
  expect(JSON.parse(readFileSync(resolvedCachePath, "utf8")).models[0].slug).toBe(
    "recovered-model",
  );
});

test("rebuilds privately when the shared cache belongs to a different Codex version", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-mismatch-"));
  const authPath = join(codexHome, "auth.json");
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(authPath, "{}", "utf8");
  writeFileSync(
    cachePath,
    JSON.stringify({
      client_version: "0.144.4",
      models: [{ slug: "stale-model", multi_agent_version: "v2" }],
    }),
    "utf8",
  );

  const originalSharedCache = readFileSync(cachePath, "utf8");
  let bootstrapCalls = 0;
  const resolvedCachePath = await ensureCodexModelCache(authPath, async (_, receivedCache) => {
    bootstrapCalls += 1;
    expect(receivedCache).not.toBe(cachePath);
    writeFileSync(
      receivedCache,
      JSON.stringify({
        client_version: BUNDLED_CODEX_VERSION,
        models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }],
      }),
      "utf8",
    );
  });

  expect(bootstrapCalls).toBe(1);
  expect(readFileSync(cachePath, "utf8")).toBe(originalSharedCache);
  expect(JSON.parse(readFileSync(resolvedCachePath, "utf8")).models[0].slug).toBe("gpt-5.6-sol");
});

test("does not let a stale hardened catalog replace a missing model cache", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-fallback-"));
  const authPath = join(codexHome, "auth.json");
  const outputPath = join(codexHome, "negotium-model-catalog.json");
  writeFileSync(authPath, "{}", "utf8");
  writeFileSync(
    outputPath,
    JSON.stringify({ models: [{ slug: "gpt-5.6-sol", multi_agent_version: "disabled" }] }),
    "utf8",
  );

  let bootstrapCalls = 0;
  const resolvedCachePath = await ensureCodexModelCache(authPath, async (_, receivedCache) => {
    bootstrapCalls += 1;
    writeFileSync(
      receivedCache,
      JSON.stringify({
        client_version: BUNDLED_CODEX_VERSION,
        models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }],
      }),
      "utf8",
    );
  });

  expect(bootstrapCalls).toBe(1);
  expect(resolvedCachePath).toBe(bundledCodexModelCachePath(authPath));
  expect(readFileSync(outputPath, "utf8")).toContain('"multi_agent_version":"disabled"');
});

test("rejects a bootstrap result generated for a different Codex version", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-still-mismatched-"));
  const authPath = join(codexHome, "auth.json");
  writeFileSync(authPath, "{}", "utf8");

  await expect(
    ensureCodexModelCache(authPath, async (_, receivedCache) => {
      writeFileSync(
        receivedCache,
        JSON.stringify({
          client_version: "99.0.0",
          models: [{ slug: "future-model", multi_agent_version: "v2" }],
        }),
        "utf8",
      );
    }),
  ).rejects.toThrow(`does not match Negotium's bundled Codex ${BUNDLED_CODEX_VERSION}`);
});

test("rejects a bootstrap result with no client version", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-missing-version-"));
  const authPath = join(codexHome, "auth.json");
  writeFileSync(authPath, "{}", "utf8");

  await expect(
    ensureCodexModelCache(authPath, async (_, receivedCache) => {
      writeFileSync(
        receivedCache,
        JSON.stringify({ models: [{ slug: "unknown-model", multi_agent_version: "v2" }] }),
        "utf8",
      );
    }),
  ).rejects.toThrow("Codex model cache version missing or invalid");
});
