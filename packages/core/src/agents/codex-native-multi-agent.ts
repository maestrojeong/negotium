import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NEGOTIUM_VERSION } from "#version";

type CodexModel = Record<string, unknown>;
type CodexModelCache = {
  models?: unknown;
};

const NEGOTIUM_MODEL_CATALOG = "negotium-model-catalog.json";
const moduleRequire = createRequire(import.meta.url);

function codexCliScriptPath(): string {
  const sdkPackagePath = moduleRequire.resolve("@openai/codex-sdk/package.json");
  const sdkRequire = createRequire(sdkPackagePath);
  return join(dirname(sdkRequire.resolve("@openai/codex/package.json")), "bin", "codex.js");
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

export async function ensureCodexModelCache(
  authFilePath: string,
  bootstrap: (codexHome: string, cachePath: string) => Promise<void> = bootstrapCodexModelCache,
): Promise<void> {
  const codexHome = dirname(authFilePath);
  const cachePath =
    process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE ?? join(codexHome, "models_cache.json");
  const hardenedCatalogPath = join(codexHome, NEGOTIUM_MODEL_CATALOG);
  if (existsSync(cachePath) || existsSync(hardenedCatalogPath)) return;
  if (process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE) {
    throw new Error(`Configured Codex model cache does not exist: ${cachePath}`);
  }
  await bootstrap(codexHome, cachePath);
}

/**
 * Codex 0.144 resolves model metadata before `features.multi_agent=false`, so
 * a model-advertised v1/v2 value still registers native collaboration tools.
 * Feed Codex an authoritative copy of its own catalog with only that field
 * disabled. Runtime MCP delegation remains available independently.
 */
export function writeCodexCatalogWithNativeMultiAgentDisabled(authFilePath: string): string {
  const codexHome = dirname(authFilePath);
  const sourcePath =
    process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE ??
    (existsSync(join(codexHome, "models_cache.json"))
      ? join(codexHome, "models_cache.json")
      : join(codexHome, NEGOTIUM_MODEL_CATALOG));
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
