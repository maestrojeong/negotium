/**
 * Cheap pre-flight auth check used to block agent switches that would
 * otherwise flip the topic to a backend the user hasn't logged into,
 * surfacing as a per-turn opaque error inside the provider. Runtime
 * failures (revoked tokens, expired sessions) still classify normally
 * via `event-processor.classifyError`.
 *
 * Each branch mirrors the auth mechanism the matching provider uses:
 *   - codex: `~/.codex/auth.json` (override `NEGOTIUM_CODEX_AUTH_FILE`)
 *   - claude: `ANTHROPIC_API_KEY` env, else macOS keychain entry
 *     `Claude Code-credentials`, else `~/.claude/.credentials.json`
 *   - maestro: `DEEPSEEK_API_KEY` for DeepSeek models, or
 *     `MOONSHOT_API_KEY` for Kimi models
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { codexAuthFilePath } from "#platform/config";
import type { AgentKind } from "#types";

export type AuthCheckResult = { ok: true } | { ok: false; error: string };

export interface AgentAuthHost {
  codexAuthFilePath(): string;
  exists(path: string): boolean;
  environment: Record<string, string | undefined>;
  homeDirectory(): string;
  operatingSystem(): NodeJS.Platform;
  hasMacOsCredential(service: string): boolean;
}

const defaultAgentAuthHost: AgentAuthHost = {
  codexAuthFilePath,
  exists: existsSync,
  environment: process.env,
  homeDirectory: homedir,
  operatingSystem: platform,
  hasMacOsCredential(service) {
    try {
      execFileSync("security", ["find-generic-password", "-s", service], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
};

export function checkAgentAuth(
  agent: AgentKind,
  host: AgentAuthHost = defaultAgentAuthHost,
): AuthCheckResult {
  switch (agent) {
    case "codex": {
      const path = host.codexAuthFilePath();
      if (host.exists(path)) return { ok: true };
      return {
        ok: false,
        error: `codex is not logged in (auth file missing at ${path}). Run \`codex login\` first`,
      };
    }
    case "claude": {
      if (host.environment.ANTHROPIC_API_KEY) return { ok: true };
      if (host.operatingSystem() === "darwin") {
        if (host.hasMacOsCredential("Claude Code-credentials")) {
          return { ok: true };
        }
        return {
          ok: false,
          error:
            "claude is not logged in (no macOS keychain entry 'Claude Code-credentials'). Run `claude` and complete login first",
        };
      }
      const path = join(host.homeDirectory(), ".claude", ".credentials.json");
      if (host.exists(path)) return { ok: true };
      return {
        ok: false,
        error: `claude is not logged in (credentials missing at ${path}). Run \`claude\` and complete login first`,
      };
    }
    case "maestro": {
      if (host.environment.DEEPSEEK_API_KEY || host.environment.MOONSHOT_API_KEY) {
        return { ok: true };
      }
      return {
        ok: false,
        error:
          "maestro is not authenticated (neither DEEPSEEK_API_KEY nor MOONSHOT_API_KEY env var is set)",
      };
    }
  }
}

/** Validate the credential required by one concrete model. */
export function checkAgentModelAuth(
  agent: AgentKind,
  model: string,
  host: AgentAuthHost = defaultAgentAuthHost,
): AuthCheckResult {
  if (agent !== "maestro") return checkAgentAuth(agent, host);
  if (model.startsWith("kimi")) {
    return host.environment.MOONSHOT_API_KEY
      ? { ok: true }
      : {
          ok: false,
          error: `maestro is not authenticated for model '${model}' (MOONSHOT_API_KEY env var not set)`,
        };
  }
  if (model.startsWith("deepseek")) {
    return host.environment.DEEPSEEK_API_KEY
      ? { ok: true }
      : {
          ok: false,
          error: `maestro is not authenticated for model '${model}' (DEEPSEEK_API_KEY env var not set)`,
        };
  }
  return checkAgentAuth(agent, host);
}
