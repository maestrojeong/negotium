import { describe, expect, test } from "bun:test";
import { extractCompactionChatPairs } from "#agents/compaction-tool-projection";
import type { ConversationEntry } from "#storage/conversations";

function entry(event: ConversationEntry["event"]): ConversationEntry {
  return { ts: "2026-08-27T00:00:00.000Z", agent: "codex", event };
}

describe("compaction tool projection", () => {
  test("keeps small tool outputs beyond the normal 200-character rollout preview", () => {
    const content = `start-${"x".repeat(600)}-end`;
    const pairs = extractCompactionChatPairs([
      entry({ type: "user_message", content: "run it" }),
      entry({ type: "tool_use", name: "exec_command", input: { cmd: "test" }, toolUseId: "t1" }),
      entry({ type: "tool_result", toolUseId: "t1", content }),
      entry({ type: "result", content: "done", stopReason: "end_turn" }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.assistantText).toContain(content);
    expect(pairs[0]?.assistantText).toContain("name: exec_command");
    expect(pairs[0]?.assistantText).toContain("id: t1");
  });

  test("bounds giant outputs while preserving both ends, salient errors, and metadata", () => {
    const content = `HEAD-${"a".repeat(35_000)}\nERROR expected 64K but received 72K\n${"b".repeat(35_000)}-TAIL`;
    const pairs = extractCompactionChatPairs([
      entry({ type: "user_message", content: "run tests" }),
      entry({
        type: "tool_use",
        name: "exec_command",
        input: { cmd: "bun test" },
        toolUseId: "t2",
      }),
      entry({
        type: "tool_result",
        toolUseId: "t2",
        content,
        isError: true,
        metadata: {
          truncatedForModel: false,
          originalBytes: 70_051,
          returnedBytes: 70_051,
          outputPath: "/tmp/full-test-output.log",
        },
      }),
      entry({ type: "result", content: "tests failed", stopReason: "end_turn" }),
    ]);
    const projected = pairs[0]?.assistantText ?? "";

    expect(projected).toContain("HEAD-");
    expect(projected).toContain("-TAIL");
    expect(projected).toContain("ERROR expected 64K but received 72K");
    expect(projected).toContain("status: error");
    expect(projected).toContain("output_path: /tmp/full-test-output.log");
    expect(projected).toContain("bounded projection");
    expect(projected).not.toContain("a".repeat(10_000));
  });

  test("keeps the newest duplicate result and replaces older copies with a hash reference", () => {
    const duplicate = `same-${"z".repeat(500)}`;
    const pairs = extractCompactionChatPairs([
      entry({ type: "user_message", content: "first" }),
      entry({ type: "tool_result", toolUseId: "old", content: duplicate }),
      entry({ type: "result", content: "first done", stopReason: "end_turn" }),
      entry({ type: "user_message", content: "second" }),
      entry({ type: "tool_result", toolUseId: "new", content: duplicate }),
      entry({ type: "result", content: "second done", stopReason: "end_turn" }),
    ]);

    expect(pairs[0]?.assistantText).toContain("duplicate of the most recent result");
    expect(pairs[1]?.assistantText).toContain(duplicate);
  });
});
