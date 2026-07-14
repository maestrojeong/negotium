import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildMaestroDisallowedTools, buildMaestroToolHooks } from "#agents/maestro-provider";
import { vaultDel, vaultSet } from "#storage/vault";

describe("maestroProvider host tool policy", () => {
  test("disallows provider-native ask/task tools through the SDK denylist", () => {
    expect(buildMaestroDisallowedTools()).toEqual([
      "AskUserQuestion",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TaskOutput",
      "TaskStop",
    ]);
    expect(buildMaestroDisallowedTools(["Bash", "AskUserQuestion"])).toEqual([
      "AskUserQuestion",
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

  test("redirects placeholders to the Vault broker and redacts tool output", async () => {
    const userId = `maestro-vault-${randomUUID()}`;
    const secret = "maestro-secret-value";
    vaultSet(userId, "API_TOKEN", secret);
    try {
      const [vaultHook] = buildMaestroToolHooks(userId);
      const blocked = await vaultHook.pre?.({
        toolName: "Bash",
        input: { command: "echo {{API_TOKEN}}" },
      });
      expect(blocked?.decision).toBe("block");

      const broker = await vaultHook.pre?.({
        toolName: "mcp__vault__vault_run",
        input: { command: "echo {{API_TOKEN}}" },
      });
      expect(broker).toEqual({ decision: "allow" });

      const post = await vaultHook.post?.({
        toolName: "mcp__vault__vault_run",
        input: { command: "echo {{API_TOKEN}}" },
        output: `result=${secret}`,
      });
      expect(post?.output).toBe("result=[REDACTED:API_TOKEN]");
    } finally {
      vaultDel(userId, "API_TOKEN");
    }
  });

  test("blocks stale native task tool calls in runtime hooks", async () => {
    const hooks = buildMaestroToolHooks("user-1");
    const nativeTaskHook = hooks.find((hook) => hook.name === "native-task-redirect");
    expect(nativeTaskHook).toBeDefined();

    const blocked = await nativeTaskHook?.pre?.({
      toolName: "TaskCreate",
      input: {},
    });
    expect(blocked?.decision).toBe("block");
    if (blocked?.decision === "block") {
      expect(blocked.error).toContain("Otium task MCP");
    }

    const allowed = await nativeTaskHook?.pre?.({
      toolName: "Read",
      input: {},
    });
    expect(allowed).toEqual({ decision: "allow" });
  });
});
