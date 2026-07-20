import { describe, expect, test } from "bun:test";
import { type AgentAuthHost, checkAgentAuth, checkAgentModelAuth } from "#agents/auth-check";

function host(overrides: Partial<AgentAuthHost> = {}): AgentAuthHost {
  return {
    codexAuthFilePath: () => "/host/codex-auth.json",
    exists: () => false,
    environment: {},
    homeDirectory: () => "/host/home",
    operatingSystem: () => "linux",
    hasMacOsCredential: () => false,
    ...overrides,
  };
}

describe("checkAgentAuth host boundary", () => {
  test("uses the caller-owned Codex auth path", () => {
    expect(
      checkAgentAuth("codex", host({ exists: (path) => path === "/host/codex-auth.json" })),
    ).toEqual({
      ok: true,
    });
    expect(checkAgentAuth("codex", host())).toEqual({
      ok: false,
      error:
        "codex is not logged in (auth file missing at /host/codex-auth.json). Run `codex login` first",
    });
  });

  test("checks host environment and platform without process globals", () => {
    expect(checkAgentAuth("claude", host({ environment: { ANTHROPIC_API_KEY: "key" } }))).toEqual({
      ok: true,
    });
    expect(
      checkAgentAuth(
        "claude",
        host({ operatingSystem: () => "darwin", hasMacOsCredential: () => true }),
      ),
    ).toEqual({ ok: true });
    expect(checkAgentAuth("maestro", host({ environment: { DEEPSEEK_API_KEY: "key" } }))).toEqual({
      ok: true,
    });
    expect(checkAgentAuth("maestro", host({ environment: { MOONSHOT_API_KEY: "key" } }))).toEqual({
      ok: true,
    });
  });

  test("checks the credential for the selected Maestro model", () => {
    const deepSeekOnly = host({ environment: { DEEPSEEK_API_KEY: "deepseek" } });
    const moonshotOnly = host({ environment: { MOONSHOT_API_KEY: "moonshot" } });

    expect(checkAgentModelAuth("maestro", "deepseek-pro", deepSeekOnly)).toEqual({ ok: true });
    expect(checkAgentModelAuth("maestro", "kimi-k3", moonshotOnly)).toEqual({ ok: true });
    expect(checkAgentModelAuth("maestro", "kimi-k2.7-code", deepSeekOnly)).toEqual({
      ok: false,
      error:
        "maestro is not authenticated for model 'kimi-k2.7-code' (MOONSHOT_API_KEY env var not set)",
    });
    expect(checkAgentModelAuth("maestro", "deepseek-pro", moonshotOnly)).toEqual({
      ok: false,
      error:
        "maestro is not authenticated for model 'deepseek-pro' (DEEPSEEK_API_KEY env var not set)",
    });
  });
});
