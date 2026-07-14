import { describe, expect, test } from "bun:test";
import { buildClaudeDisallowedTools } from "#agents/claude-provider";

describe("claudeProvider host tool policy", () => {
  test("disallows native task store and subagent tools by default", () => {
    expect(buildClaudeDisallowedTools()).toEqual([
      "AskUserQuestion",
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

  test("preserves explicit custom-agent SDK path while still blocking private task stores", () => {
    expect(buildClaudeDisallowedTools(["Bash", "TaskCreate"], { allowNativeAgents: true })).toEqual(
      ["AskUserQuestion", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "Bash"],
    );
  });
});
