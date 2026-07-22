import { afterEach, describe, expect, test } from "bun:test";
import {
  configureAgentExecutionHost,
  hostedClaudeCodeExecutablePath,
  hostedMcpServers,
  redactHostedSecrets,
  referencesHostedSecretStorage,
  resolveAgentExecutionHost,
  shouldRedirectHostedVaultTool,
  substituteHostedSecrets,
  transformHostedQueryOptions,
  withAgentExecutionHost,
} from "#agents/execution-host";
import type { AgentQueryOptions } from "#types";

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function opts(): AgentQueryOptions {
  return {
    agent: "codex",
    cwd: "/tmp",
    prompt: "hello",
    systemPrompt: "system",
    userId: "u1",
  };
}

describe("agent execution host", () => {
  test("uses the Claude SDK bundled executable by default", () => {
    expect(hostedClaudeCodeExecutablePath()).toBeUndefined();
  });

  test("allows an embedding host to opt into a custom Claude executable", () => {
    disposers.push(
      configureAgentExecutionHost({
        claudeCodeExecutablePath: () => "/opt/custom/claude",
      }),
    );

    expect(hostedClaudeCodeExecutablePath()).toBe("/opt/custom/claude");
  });

  test("injects host-owned MCP and device-local secret services", () => {
    disposers.push(
      configureAgentExecutionHost({
        getMcpServersForQuery: () => ({ local_vault: { command: "vault" } }),
        redactVaultSecrets: (_userId, value) => value.replaceAll("secret", "[redacted]"),
        substituteVaultSecrets: (_userId, value) => value.replaceAll("{{TOKEN}}", "secret"),
        referencesRuntimeSecretStorage: (value) => value === "/device/vault.db",
        shouldRedirectVaultTool: (_userId, toolName) => toolName === "Bash",
      }),
    );

    expect(hostedMcpServers(opts())).toEqual({ local_vault: { command: "vault" } });
    expect(redactHostedSecrets("u1", "a secret")).toBe("a [redacted]");
    expect(substituteHostedSecrets("u1", "use {{TOKEN}}")).toBe("use secret");
    expect(referencesHostedSecretStorage("/device/vault.db")).toBe(true);
    expect(shouldRedirectHostedVaultTool("u1", "Bash", {})).toBe(true);
  });

  test("allows a private host to transform a copied query", () => {
    const original = opts();
    disposers.push(
      configureAgentExecutionHost({
        transformQueryOptions: (input) => ({ ...input, prompt: `${input.prompt}\nprivate host` }),
      }),
    );

    expect(transformHostedQueryOptions({ ...original }).prompt).toBe("hello\nprivate host");
    expect(original.prompt).toBe("hello");
  });

  test("out-of-order disposal does not replace a newer host", () => {
    const disposeFirst = configureAgentExecutionHost({
      getMcpServersForQuery: () => ({ first: {} }),
    });
    const disposeSecond = configureAgentExecutionHost({
      getMcpServersForQuery: () => ({ second: {} }),
    });
    disposers.push(disposeFirst, disposeSecond);

    disposeFirst();
    expect(hostedMcpServers(opts())).toEqual({ second: {} });
    disposeSecond();
    expect(hostedMcpServers(opts())).not.toEqual({ first: {} });
  });

  test("isolates call-local hosts across concurrent async work", async () => {
    const first = resolveAgentExecutionHost({ getMcpServersForQuery: () => ({ first: {} }) });
    const second = resolveAgentExecutionHost({ getMcpServersForQuery: () => ({ second: {} }) });

    const [firstResult, secondResult] = await Promise.all([
      withAgentExecutionHost(first, async () => {
        await Promise.resolve();
        return hostedMcpServers(opts());
      }),
      withAgentExecutionHost(second, async () => {
        await Promise.resolve();
        return hostedMcpServers(opts());
      }),
    ]);

    expect(firstResult).toEqual({ first: {} });
    expect(secondResult).toEqual({ second: {} });
  });
});
