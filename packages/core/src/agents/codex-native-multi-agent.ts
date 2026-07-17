import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type CodexModel = Record<string, unknown>;
type CodexModelCache = {
  models?: unknown;
};

const NEGOTIUM_MODEL_CATALOG = "negotium-model-catalog.json";

/**
 * Codex 0.144 resolves model metadata before `features.multi_agent=false`, so
 * a model-advertised v1/v2 value still registers native collaboration tools.
 * Feed Codex an authoritative copy of its own catalog with only that field
 * disabled. Runtime MCP delegation remains available independently.
 */
export function writeCodexCatalogWithNativeMultiAgentDisabled(authFilePath: string): string {
  const codexHome = dirname(authFilePath);
  const sourcePath =
    process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE ?? join(codexHome, "models_cache.json");
  const outputPath = join(codexHome, NEGOTIUM_MODEL_CATALOG);

  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as CodexModelCache;
  if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error(`Codex model cache has no models: ${sourcePath}`);
  }

  const models = parsed.models.map((model, index): CodexModel => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error(`Codex model cache entry ${index} is invalid: ${sourcePath}`);
    }
    return { ...(model as CodexModel), multi_agent_version: "disabled" };
  });
  const contents = `${JSON.stringify({ models }, null, 2)}\n`;

  if (existsSync(outputPath) && readFileSync(outputPath, "utf8") === contents) {
    return outputPath;
  }

  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, outputPath);
    chmodSync(outputPath, 0o600);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // renameSync normally consumed the temporary file.
    }
  }
  return outputPath;
}
