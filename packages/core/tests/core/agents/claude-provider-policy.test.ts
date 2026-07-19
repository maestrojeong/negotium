import { describe, expect, test } from "bun:test";
import { buildClaudeDisallowedTools, substituteClaudeToolInput } from "#agents/claude-provider";
import { configureAgentExecutionHost } from "#agents/execution-host";

describe("claudeProvider host tool policy", () => {
  test("disallows native task store and subagent tools by default", () => {
    expect(buildClaudeDisallowedTools()).toEqual([
      "AskUserQuestion",
      "Workflow",
      "TodoWrite",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "Task",
      "Agent",
      "TaskOutput",
      "TaskStop",
    ]);
  });

  test("keeps native subagents blocked even when callers add other policy entries", () => {
    expect(buildClaudeDisallowedTools(["Bash", "TaskCreate"])).toEqual([
      "AskUserQuestion",
      "Workflow",
      "TodoWrite",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "Task",
      "Agent",
      "TaskOutput",
      "TaskStop",
      "Bash",
    ]);
  });

  test("substitutes Vault placeholders in normal tool input", () => {
    const dispose = configureAgentExecutionHost({
      substituteVaultSecrets: (_userId, value) => value.replaceAll("{{TOKEN}}", "secret"),
    });
    try {
      expect(
        substituteClaudeToolInput("user", {
          command: "use {{TOKEN}}",
          nested: ["{{TOKEN}}"],
        }),
      ).toEqual({ command: "use secret", nested: ["secret"] });
    } finally {
      dispose();
    }
  });
});
