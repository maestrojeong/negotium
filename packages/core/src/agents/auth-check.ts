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
 *   - maestro: `DEEPSEEK_API_KEY`/Vault `DEEPSEEK_API_KEY` for DeepSeek
 *     models, or `MOONSHOT_API_KEY`/Vault `MOONSHOT_API_KEY` for Kimi
 *     models
 *
 * Maestro credentials resolve per-user when `userId` is supplied: each
 * topic owner's own Vault entry (`/vault set DEEPSEEK_API_KEY …`) is tried
 * before the process-wide env var, so a shared Negotium deployment doesn't
 * require every user to share one operator-configured `.env`. Callers that
 * omit `userId` (system/CLI bootstrap paths with no per-user context) fall
 * back to env-only, matching the pre-Vault behavior exactly.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { codexAuthFilePath } from "#platform/config";
import { vaultGetValue } from "#storage/vault";
import type { AgentKind } from "#types";

export type AuthCheckResult = { ok: true } | { ok: false; error: string };

export interface AgentAuthHost {
  codexAuthFilePath(): string;
  exists(path: string): boolean;
  environment: Record<string, string | undefined>;
  homeDirectory(): string;
  operatingSystem(): NodeJS.Platform;
  hasMacOsCredential(service: string): boolean;
  getVaultValue(userId: string, key: string): string | undefined;
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
  getVaultValue: vaultGetValue,
};

/** True when `key` is available via the user's Vault entry or process env. */
function hasMaestroCredential(
  host: AgentAuthHost,
  key: "DEEPSEEK_API_KEY" | "MOONSHOT_API_KEY",
  userId: string | undefined,
): boolean {
  if (userId && host.getVaultValue(userId, key)?.trim()) return true;
  return Boolean(host.environment[key]?.trim());
}

export function checkAgentAuth(
  agent: AgentKind,
  host: AgentAuthHost = defaultAgentAuthHost,
  userId?: string,
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
      if (
        hasMaestroCredential(host, "DEEPSEEK_API_KEY", userId) ||
        hasMaestroCredential(host, "MOONSHOT_API_KEY", userId)
      ) {
        return { ok: true };
      }
      return {
        ok: false,
        error:
          "maestro is not authenticated (set DEEPSEEK_API_KEY or MOONSHOT_API_KEY via /vault set, or as an env var)",
      };
    }
  }
}

/** Validate the credential required by one concrete model. */
export function checkAgentModelAuth(
  agent: AgentKind,
  model: string,
  host: AgentAuthHost = defaultAgentAuthHost,
  userId?: string,
): AuthCheckResult {
  if (agent !== "maestro") return checkAgentAuth(agent, host, userId);
  if (model.startsWith("kimi")) {
    return hasMaestroCredential(host, "MOONSHOT_API_KEY", userId)
      ? { ok: true }
      : {
          ok: false,
          error: `maestro is not authenticated for model '${model}' (set MOONSHOT_API_KEY via /vault set, or as an env var)`,
        };
  }
  if (model.startsWith("deepseek")) {
    return hasMaestroCredential(host, "DEEPSEEK_API_KEY", userId)
      ? { ok: true }
      : {
          ok: false,
          error: `maestro is not authenticated for model '${model}' (set DEEPSEEK_API_KEY via /vault set, or as an env var)`,
        };
  }
  return checkAgentAuth(agent, host, userId);
}
