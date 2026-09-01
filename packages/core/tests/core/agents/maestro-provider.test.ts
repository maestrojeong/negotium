import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMaestroDisallowedTools,
  buildMaestroToolHooks,
  resolveMaestroApiKeyOverrides,
} from "#agents/maestro-provider";
import { vaultDel, vaultSet } from "#storage/vault";

describe("maestroProvider host tool policy", () => {
  test("forwards the invocation-only system prompt to maestro-agent-sdk", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../../../src/agents/maestro-provider.ts"),
      "utf8",
    );
    expect(source).toContain("ephemeralSystemPrompt: opts.ephemeralSystemPrompt,");
  });

  test("disallows the provider-native ask tool through the SDK denylist", () => {
    expect(buildMaestroDisallowedTools()).toEqual(["AskUserQuestion"]);
    expect(buildMaestroDisallowedTools(["Bash", "AskUserQuestion"])).toEqual([
      "AskUserQuestion",
      "Bash",
    ]);
  });

  test("removes every built-in tool for no-tool auxiliary calls", () => {
    const allBuiltIns = [
      "Bash",
      "Read",
      "ReadToolOutput",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "GeminiImageQA",
      "ToolSearch",
      "AskUserQuestion",
    ];
    expect(buildMaestroDisallowedTools([], "none")).toEqual(allBuiltIns);
    expect(buildMaestroDisallowedTools([], "compaction-log")).toEqual(allBuiltIns);
  });

  test("keeps vault access control in runtime hooks", async () => {
    const [vaultHook] = buildMaestroToolHooks("user-1");
    expect(vaultHook.name).toBe("vault-guard");

    const blocked = await vaultHook.pre?.({
      toolName: "Read",
      input: { file_path: "/tmp/vault.db" },
    });
    expect(blocked?.decision).toBe("block");
    if (blocked?.decision === "block") {
      expect(blocked.error).toContain("secret storage");
    }

    const allowed = await vaultHook.pre?.({
      toolName: "Read",
      input: { file_path: "/tmp/example.txt" },
    });
    expect(allowed).toEqual({ decision: "allow" });
  });

  test("substitutes placeholders before normal tools and redacts tool output", async () => {
    const userId = `maestro-vault-${randomUUID()}`;
    const secret = "maestro-secret-value";
    vaultSet(userId, "API_TOKEN", secret);
    try {
      const [vaultHook] = buildMaestroToolHooks(userId);
      const substituted = await vaultHook.pre?.({
        toolName: "Bash",
        input: { command: "echo {{API_TOKEN}}" },
      });
      expect(substituted).toEqual({
        decision: "modify",
        input: { command: `echo ${secret}` },
      });

      for (const toolName of [
        "mcp__session_comm__tell_session",
        "mcp__session_comm__ask_session",
        "mcp__task__task_update",
        "mcp__wiki__wiki_query",
        "mcp__logging__write_log",
        "Write",
      ]) {
        const input = { message: "keep {{API_TOKEN}}" };
        const result = await vaultHook.pre?.({ toolName, input });
        expect(result).toEqual({ decision: "allow" });
        expect(input.message).toBe("keep {{API_TOKEN}}");
      }

      const post = await vaultHook.post?.({
        toolName: "Bash",
        input: { command: "echo {{API_TOKEN}}" },
        output: `result=${secret}`,
      });
      expect(post?.output).toBe("result=[REDACTED:API_TOKEN]");
    } finally {
      vaultDel(userId, "API_TOKEN");
    }
  });

  test("blocks the provider-native ask tool in runtime hooks", async () => {
    const hooks = buildMaestroToolHooks("user-1");
    const policyHook = hooks.find((hook) => hook.name === "provider-owned-tool-redirect");
    expect(policyHook).toBeDefined();

    const ask = await policyHook?.pre?.({ toolName: "AskUserQuestion", input: {} });
    expect(ask?.decision).toBe("block");
    if (ask?.decision === "block") expect(ask.error).toContain("ask_user_question");

    const allowed = await policyHook?.pre?.({
      toolName: "Read",
      input: {},
    });
    expect(allowed).toEqual({ decision: "allow" });
  });

  test("passes trimmed per-user provider keys and ignores whitespace-only values", () => {
    const userId = `maestro-provider-keys-${randomUUID()}`;
    vaultSet(userId, "DEEPSEEK_API_KEY", "  deepseek-key  ");
    vaultSet(userId, "MOONSHOT_API_KEY", "    ");
    vaultSet(userId, "GLM_API_KEY", "  glm-key  ");
    try {
      expect(resolveMaestroApiKeyOverrides(userId)).toEqual({
        deepseek: "deepseek-key",
        glm: "glm-key",
      });
    } finally {
      vaultDel(userId, "DEEPSEEK_API_KEY");
      vaultDel(userId, "MOONSHOT_API_KEY");
      vaultDel(userId, "GLM_API_KEY");
    }
  });
});
