import { describe, expect, test } from "bun:test";
import { buildClaudeDisallowedTools } from "#agents/claude-provider";

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
});
