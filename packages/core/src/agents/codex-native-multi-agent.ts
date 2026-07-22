import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NEGOTIUM_VERSION } from "#version";

type CodexModel = Record<string, unknown>;
type CodexModelCache = {
  client_version?: unknown;
  models?: unknown;
};

const moduleRequire = createRequire(import.meta.url);
const codexSdkPackagePath = moduleRequire.resolve("@openai/codex-sdk/package.json");
const codexSdkRequire = createRequire(codexSdkPackagePath);
const bundledCodexPackagePath = codexSdkRequire.resolve("@openai/codex/package.json");

function readPackageVersion(packageJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !parsed.version.trim()) {
    throw new Error(`Codex package has no valid version: ${packageJsonPath}`);
  }
  return parsed.version;
}

export const BUNDLED_CODEX_VERSION = readPackageVersion(bundledCodexPackagePath);
const SAFE_BUNDLED_CODEX_VERSION = BUNDLED_CODEX_VERSION.replace(/[^a-zA-Z0-9._-]/g, "_");
const NEGOTIUM_MODEL_CACHE = `negotium-models-cache-${SAFE_BUNDLED_CODEX_VERSION}.json`;
const NEGOTIUM_MODEL_CATALOG = `negotium-model-catalog-${SAFE_BUNDLED_CODEX_VERSION}.json`;

function codexCliScriptPath(): string {
  return join(dirname(bundledCodexPackagePath), "bin", "codex.js");
}

function parseCodexModelCache(contents: string, sourcePath: string): CodexModelCache {
  let parsed: CodexModelCache;
  try {
    parsed = JSON.parse(contents) as CodexModelCache;
  } catch (error) {
    throw new Error(`Codex model cache is invalid JSON: ${sourcePath}`, { cause: error });
  }
  if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error(`Codex model cache has no models: ${sourcePath}`);
  }
  return parsed;
}

function readCodexModelCache(cachePath: string): {
  contents: string;
  parsed: CodexModelCache;
} {
  const contents = readFileSync(cachePath, "utf8");
  return { contents, parsed: parseCodexModelCache(contents, cachePath) };
}

function readCompatibleCodexModelCache(cachePath: string): {
  contents: string;
  parsed: CodexModelCache;
} {
  const cache = readCodexModelCache(cachePath);
  if (cache.parsed.client_version !== BUNDLED_CODEX_VERSION) {
    const found =
      typeof cache.parsed.client_version === "string"
        ? cache.parsed.client_version
        : "missing or invalid";
    throw new Error(
      `Codex model cache version ${found} does not match Negotium's bundled Codex ${BUNDLED_CODEX_VERSION}: ${cachePath}`,
    );
  }
  return cache;
}

function writePrivateFileAtomic(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // renameSync normally consumed the temporary file.
    }
  }
}

export function bundledCodexModelCachePath(authFilePath: string): string {
  return join(dirname(authFilePath), NEGOTIUM_MODEL_CACHE);
}

async function bootstrapCodexModelCache(codexHome: string, cachePath: string): Promise<void> {
  const child = spawn(process.execPath, [codexCliScriptPath(), "app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "pipe"],
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    const timer = setTimeout(
      () => finish(new Error("timed out while refreshing the Codex model catalog")),
      15_000,
    );

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // The app server may already have exited after stdin closed.
      }
      if (error) reject(error);
      else if (!existsSync(cachePath)) reject(new Error("Codex did not create its model cache"));
      else resolve();
    };

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += String(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `Codex model catalog refresh exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        let message: { id?: number; error?: { message?: string } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(new Error(message.error.message || "Codex initialization failed"));
            return;
          }
          send({ method: "initialized" });
          send({ id: 2, method: "model/list", params: { includeHidden: true } });
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(message.error.message || "Codex model listing failed"));
          } else {
            finish();
          }
          return;
        }
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "negotium", version: NEGOTIUM_VERSION },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function bootstrapIsolatedCodexModelCache(
  authFilePath: string,
  bootstrap: (codexHome: string, cachePath: string) => Promise<void>,
): Promise<string> {
  const sourceHome = dirname(authFilePath);
  const isolatedHome = mkdtempSync(join(tmpdir(), "negotium-codex-models-"));
  const isolatedCachePath = join(isolatedHome, "models_cache.json");

  try {
    const isolatedAuthPath = join(isolatedHome, "auth.json");
    copyFileSync(authFilePath, isolatedAuthPath);
    chmodSync(isolatedAuthPath, 0o600);

    // Preserve custom provider configuration while keeping the bundled CLI's
    // cache write completely outside the user's shared CODEX_HOME.
    const sourceConfigPath = join(sourceHome, "config.toml");
    if (existsSync(sourceConfigPath)) {
      const isolatedConfigPath = join(isolatedHome, "config.toml");
      copyFileSync(sourceConfigPath, isolatedConfigPath);
      chmodSync(isolatedConfigPath, 0o600);
    }

    await bootstrap(isolatedHome, isolatedCachePath);
    return readCompatibleCodexModelCache(isolatedCachePath).contents;
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

export async function ensureCodexModelCache(
  authFilePath: string,
  bootstrap: (codexHome: string, cachePath: string) => Promise<void> = bootstrapCodexModelCache,
): Promise<string> {
  const codexHome = dirname(authFilePath);
  const configuredCachePath = process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE;
  if (configuredCachePath) {
    if (!existsSync(configuredCachePath)) {
      throw new Error(`Configured Codex model cache does not exist: ${configuredCachePath}`);
    }
    readCompatibleCodexModelCache(configuredCachePath);
    return configuredCachePath;
  }

  // The global Codex CLI owns models_cache.json and may update it to a schema
  // newer than the SDK bundled by Negotium. Snapshot a cache generated for our
  // exact bundled version so later global CLI updates cannot break turns.
  const bundledCachePath = bundledCodexModelCachePath(authFilePath);
  const sharedCachePath = join(codexHome, "models_cache.json");
  if (existsSync(sharedCachePath)) {
    try {
      const shared = readCompatibleCodexModelCache(sharedCachePath);
      // Keep model metadata fresh while the global CLI remains compatible.
      writePrivateFileAtomic(bundledCachePath, shared.contents);
      return bundledCachePath;
    } catch {
      // A compatible private snapshot is safer than failing because another
      // process briefly exposed an incomplete shared-cache write.
    }
  }

  if (existsSync(bundledCachePath)) {
    try {
      readCompatibleCodexModelCache(bundledCachePath);
      return bundledCachePath;
    } catch {
      // Re-bootstrap below instead of passing a corrupt or version-mismatched
      // private snapshot into this SDK version.
    }
  }

  const refreshedContents = await bootstrapIsolatedCodexModelCache(authFilePath, bootstrap);
  writePrivateFileAtomic(bundledCachePath, refreshedContents);
  return bundledCachePath;
}

/**
 * Codex can resolve model metadata before `features.multi_agent=false`, so a
 * model-advertised v1/v2 value may still register native collaboration tools.
 * Feed Codex an authoritative copy of its own catalog with only that field
 * disabled. Runtime MCP delegation remains available independently.
 */
export function writeCodexCatalogWithNativeMultiAgentDisabled(
  authFilePath: string,
  sourcePath: string,
): string {
  const codexHome = dirname(authFilePath);
  const outputPath = join(codexHome, NEGOTIUM_MODEL_CATALOG);

  const parsed = readCodexModelCache(sourcePath).parsed;

  const models = (parsed.models as unknown[]).map((model, index): CodexModel => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw new Error(`Codex model cache entry ${index} is invalid: ${sourcePath}`);
    }
    return { ...(model as CodexModel), multi_agent_version: "disabled" };
  });
  const contents = `${JSON.stringify({ models }, null, 2)}\n`;
  writePrivateFileAtomic(outputPath, contents);
  return outputPath;
}
