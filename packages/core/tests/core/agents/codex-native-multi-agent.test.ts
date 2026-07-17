import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCodexModelCache,
  writeCodexCatalogWithNativeMultiAgentDisabled,
} from "#agents/codex-native-multi-agent";

test("bootstraps a missing Codex model cache before hardening the catalog", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-bootstrap-"));
  const authPath = join(codexHome, "auth.json");
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(authPath, "{}", "utf8");

  let bootstrapCalls = 0;
  await ensureCodexModelCache(authPath, async (receivedHome, receivedCache) => {
    bootstrapCalls += 1;
    expect(receivedHome).toBe(codexHome);
    expect(receivedCache).toBe(cachePath);
    writeFileSync(
      cachePath,
      JSON.stringify({ models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }] }),
      "utf8",
    );
  });

  expect(bootstrapCalls).toBe(1);
  const outputPath = writeCodexCatalogWithNativeMultiAgentDisabled(authPath);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  expect(output.models[0].multi_agent_version).toBe("disabled");
});

test("reuses an existing hardened catalog when the upstream cache is absent", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "negotium-codex-fallback-"));
  const authPath = join(codexHome, "auth.json");
  const outputPath = join(codexHome, "negotium-model-catalog.json");
  writeFileSync(authPath, "{}", "utf8");
  writeFileSync(
    outputPath,
    JSON.stringify({ models: [{ slug: "gpt-5.6-sol", multi_agent_version: "disabled" }] }),
    "utf8",
  );

  await ensureCodexModelCache(authPath, async () => {
    throw new Error("bootstrap should not run");
  });
  expect(writeCodexCatalogWithNativeMultiAgentDisabled(authPath)).toBe(outputPath);
});
