import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  createCodexVaultHookBridge,
  evaluateCodexVaultPreToolUse,
} from "#agents/codex-vault-hook-bridge";
import { configureAgentExecutionHost } from "#agents/execution-host";

const operations = {
  referencesSensitiveStorage(value: unknown): boolean {
    return JSON.stringify(value).includes("vault.db");
  },
  substitute(_userId: string, value: string): string {
    return value.replaceAll("{{TOKEN}}", "secret-value");
  },
};

describe("Codex Vault PreToolUse hook", () => {
  test("substitutes placeholders only in transient execution tools", () => {
    expect(
      evaluateCodexVaultPreToolUse(
        { tool_name: "Bash", tool_input: { command: "curl -H '{{TOKEN}}'" } },
        "user-1",
        operations,
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "curl -H 'secret-value'" },
      },
    });

    expect(
      evaluateCodexVaultPreToolUse(
        { tool_name: "mcp__task__task_create", tool_input: { subject: "{{TOKEN}}" } },
        "user-1",
        operations,
      ),
    ).toEqual({});
  });

  test("denies direct access to sensitive runtime storage before substitution", () => {
    expect(
      evaluateCodexVaultPreToolUse(
        { tool_name: "Bash", tool_input: { command: "cat /state/vault.db {{TOKEN}}" } },
        "user-1",
        operations,
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Runtime secret storage access is not permitted",
      },
    });
  });

  test("uses the configured execution host through the private hook bridge", async () => {
    const disposeHost = configureAgentExecutionHost({
      substituteVaultSecrets: (_userId, value) => value.replaceAll("{{TOKEN}}", "host-secret"),
      referencesRuntimeSecretStorage: (value) => JSON.stringify(value).includes("vault.db"),
    });
    const bridge = await createCodexVaultHookBridge("user-1");
    try {
      const command = bridge.hooks.PreToolUse[0]?.hooks[0]?.command;
      if (!command) throw new Error("hook command was not configured");
      const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "use {{TOKEN}}" },
        }),
      );
      const output = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      const exitCode = await new Promise<number | null>((resolve) =>
        child.once("exit", (code) => resolve(code)),
      );
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(output)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: "use host-secret" },
        },
      });
    } finally {
      await bridge.close();
      disposeHost();
    }
  });
});
