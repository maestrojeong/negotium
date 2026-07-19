import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildMaestroDisallowedTools, buildMaestroToolHooks } from "#agents/maestro-provider";
import { vaultDel, vaultSet } from "#storage/vault";

describe("maestroProvider host tool policy", () => {
  test("disallows provider-native ask/task/subagent tools through the SDK denylist", () => {
    expect(buildMaestroDisallowedTools()).toEqual([
      "AskUserQuestion",
      "Agent",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TaskOutput",
      "TaskStop",
    ]);
    expect(buildMaestroDisallowedTools(["Bash", "AskUserQuestion"])).toEqual([
      "AskUserQuestion",
      "Agent",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TaskOutput",
      "TaskStop",
      "Bash",
    ]);
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

  test("blocks stale provider-owned task, ask, and subagent calls in runtime hooks", async () => {
    const hooks = buildMaestroToolHooks("user-1");
    const policyHook = hooks.find((hook) => hook.name === "provider-owned-tool-redirect");
    expect(policyHook).toBeDefined();

    const blocked = await policyHook?.pre?.({
      toolName: "TaskCreate",
      input: {},
    });
    expect(blocked?.decision).toBe("block");
    if (blocked?.decision === "block") {
      expect(blocked.error).toContain("shared task MCP");
    }

    const ask = await policyHook?.pre?.({ toolName: "AskUserQuestion", input: {} });
    expect(ask?.decision).toBe("block");
    if (ask?.decision === "block") expect(ask.error).toContain("ask_user_question");

    const agent = await policyHook?.pre?.({ toolName: "Agent", input: {} });
    expect(agent?.decision).toBe("block");
    if (agent?.decision === "block") expect(agent.error).toContain("spawn_subagent");

    const allowed = await policyHook?.pre?.({
      toolName: "Read",
      input: {},
    });
    expect(allowed).toEqual({ decision: "allow" });
  });
});
