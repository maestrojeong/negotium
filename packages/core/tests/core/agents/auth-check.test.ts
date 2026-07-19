import { describe, expect, test } from "bun:test";
import { type AgentAuthHost, checkAgentAuth } from "#agents/auth-check";

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
  });
});
