import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

  /**
   * This case asserts on the bridge's `#!/bin/sh` wrapper and runs the hook
   * command through `/bin/sh -c`. The wrapper is still POSIX-only — porting it
   * to Windows needs a `.cmd` equivalent that reproduces its `exec` argument
   * handling, which has not been done — so on a host without `/bin/sh` there is
   * nothing here to exercise yet. Skipping is not hiding a Windows regression;
   * it is marking work that has not landed.
   */
  test.skipIf(!existsSync("/bin/sh"))(
    "uses the configured execution host through the private hook bridge",
    async () => {
      const disposeHost = configureAgentExecutionHost({
        substituteVaultSecrets: (_userId, value) => value.replaceAll("{{TOKEN}}", "host-secret"),
        referencesRuntimeSecretStorage: (value) => JSON.stringify(value).includes("vault.db"),
      });
      const bridge = await createCodexVaultHookBridge("user-1");
      try {
        const command = bridge.hooks.PreToolUse[0]?.hooks[0]?.command;
        if (!command) throw new Error("hook command was not configured");
        expect(command).not.toContain(bridge.environment.NEGOTIUM_CODEX_VAULT_HOOK_SOCKET);
        expect(command).not.toContain(bridge.environment.NEGOTIUM_CODEX_VAULT_HOOK_TOKEN);
        const wrapper = await Bun.file(bridge.codexPathOverride).text();
        expect(wrapper).toContain("exec --dangerously-bypass-hook-trust");
        expect(wrapper).toContain("export NEGOTIUM_CODEX_VAULT_HOOK_SOCKET=");
        expect(wrapper).toContain("export NEGOTIUM_CODEX_VAULT_HOOK_TOKEN=");
        const child = spawn("/bin/sh", ["-c", command], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...bridge.environment },
        });
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
    },
  );

  /**
   * On Windows the codex wrapper is a compiled exe (a `.cmd` cannot be spawned
   * by the SDK), so the bridge must hand back an `.exe` next to its private
   * config, with the capability in that file rather than the hook command.
   */
  test.skipIf(process.platform !== "win32")(
    "builds an exe wrapper and a private config on Windows",
    async () => {
      const bridge = await createCodexVaultHookBridge("user-1");
      try {
        expect(bridge.codexPathOverride.endsWith(".exe")).toBe(true);
        const cfgPath = bridge.codexPathOverride.replace(/\.exe$/, ".cfg");
        const lines = (await Bun.file(cfgPath).text()).split("\n");
        expect(lines).toHaveLength(4);
        expect(lines[2]).toBe(bridge.environment.NEGOTIUM_CODEX_VAULT_HOOK_SOCKET);
        expect(lines[3]).toBe(bridge.environment.NEGOTIUM_CODEX_VAULT_HOOK_TOKEN);
        const command = bridge.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
        expect(command).not.toContain(lines[3] ?? "");
      } finally {
        await bridge.close();
      }
    },
  );
});
