import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type BundledClaudeRuntime =
  | { ok: true; sdkVersion: string; claudeCodeVersion: string }
  | { ok: false; error: string };

let cached: BundledClaudeRuntime | undefined;

export function inspectBundledClaudeRuntime(): BundledClaudeRuntime {
  if (cached) return cached;
  try {
    const require = createRequire(import.meta.url);
    const sdkDir = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const sdkPackage = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    const manifest = JSON.parse(readFileSync(join(sdkDir, "manifest.json"), "utf8")) as {
      version?: unknown;
    };
    const sdkVersion = typeof sdkPackage.version === "string" ? sdkPackage.version : "";
    const claudeCodeVersion = typeof manifest.version === "string" ? manifest.version : "";
    if (!sdkVersion || !claudeCodeVersion) {
      cached = { ok: false, error: "Claude Agent SDK runtime version metadata is incomplete" };
    } else if (sdkVersion.split(".").at(-1) !== claudeCodeVersion.split(".").at(-1)) {
      cached = {
        ok: false,
        error: `Claude Agent SDK ${sdkVersion} does not match bundled Claude Code ${claudeCodeVersion}`,
      };
    } else {
      cached = { ok: true, sdkVersion, claudeCodeVersion };
    }
  } catch (error) {
    cached = {
      ok: false,
      error: `Failed to inspect bundled Claude runtime: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return cached;
}
