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

  test("substitutes Vault placeholders only in allowlisted execution inputs", () => {
    const dispose = configureAgentExecutionHost({
      substituteVaultSecrets: (_userId, value) => value.replaceAll("{{TOKEN}}", "secret"),
    });
    try {
      expect(
        substituteClaudeToolInput("user", "Bash", {
          command: "use {{TOKEN}}",
          nested: ["{{TOKEN}}"],
        }),
      ).toEqual({ command: "use secret", nested: ["secret"] });

      expect(
        substituteClaudeToolInput("user", "mcp__playwright__browser_fill", {
          value: "{{TOKEN}}",
        }),
      ).toEqual({ value: "secret" });

      for (const toolName of [
        "mcp__session_comm__tell_session",
        "mcp__session_comm__ask_session",
        "mcp__task__task_create",
        "mcp__wiki__wiki_query",
        "mcp__logging__write_log",
        "Write",
      ]) {
        const input = { message: "keep {{TOKEN}}" };
        expect(substituteClaudeToolInput("user", toolName, input)).toBe(input);
      }
    } finally {
      dispose();
    }
  });
});
