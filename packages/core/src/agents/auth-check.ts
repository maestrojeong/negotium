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
 *   - maestro: `DEEPSEEK_API_KEY` env
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { codexAuthFilePath } from "#platform/config";
import type { AgentKind } from "#types";

export type AuthCheckResult = { ok: true } | { ok: false; error: string };

export function checkAgentAuth(agent: AgentKind): AuthCheckResult {
  switch (agent) {
    case "codex": {
      const path = codexAuthFilePath();
      if (existsSync(path)) return { ok: true };
      return {
        ok: false,
        error: `codex is not logged in (auth file missing at ${path}). Run \`codex login\` first`,
      };
    }
    case "claude": {
      if (process.env.ANTHROPIC_API_KEY) return { ok: true };
      if (platform() === "darwin") {
        try {
          execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
            stdio: "ignore",
          });
          return { ok: true };
        } catch {
          return {
            ok: false,
            error:
              "claude is not logged in (no macOS keychain entry 'Claude Code-credentials'). Run `claude` and complete login first",
          };
        }
      }
      const path = join(homedir(), ".claude", ".credentials.json");
      if (existsSync(path)) return { ok: true };
      return {
        ok: false,
        error: `claude is not logged in (credentials missing at ${path}). Run \`claude\` and complete login first`,
      };
    }
    case "maestro": {
      if (process.env.DEEPSEEK_API_KEY) return { ok: true };
      return {
        ok: false,
        error: "maestro is not authenticated (DEEPSEEK_API_KEY env var not set)",
      };
    }
  }
}
