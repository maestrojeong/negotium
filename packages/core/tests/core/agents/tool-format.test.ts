import { describe, expect, test } from "bun:test";
import { formatToolUse, summarizeShellCommand, summarizeToolInput } from "#agents/tool-format";

describe("formatToolUse", () => {
  test("View shows the question before the image path", () => {
    expect(
      formatToolUse("View", {
        image_path: "/tmp/uploads/photo.jpg",
        question: "What text is visible in this image?",
      }),
    ).toBe("View(What text is visible in this image? [photo.jpg])");
  });

  test("keeps generic file_path formatting for other tools", () => {
    expect(formatToolUse("Read", { file_path: "/tmp/uploads/photo.jpg" })).toBe(
      "Read(/tmp/uploads/photo.jpg)",
    );
  });

  test("turns wrapped compound shell commands into compact intent labels", () => {
    expect(
      summarizeShellCommand(
        `/bin/zsh -lc "printf '%s\\n' '--- repo ---' && git -C /Users/me/clawgram status --short --branch"`,
      ),
    ).toBe("git status");
    expect(
      summarizeShellCommand(
        `/bin/zsh -lc "git diff --stat && printf '%s\\n' '--- package ---' && sed -n '1,180p' package.json"`,
      ),
    ).toBe("git diff · sed package.json");
    expect(
      summarizeShellCommand("/Users/me/.bun/bin/bun test tests/a.test.ts tests/b.test.ts"),
    ).toBe("bun test 2 files");
  });

  test("uses the compact shell summary in labels and client-safe input", () => {
    const command = `/bin/zsh -lc "pwd && rg --files attachments /Users/me/wiki"`;
    expect(formatToolUse("Bash", { command })).toBe("Bash(pwd · rg files attachments +1)");
    expect(summarizeToolInput("Bash", { command })).toEqual({
      command: "pwd · rg files attachments +1",
    });
  });

  test("summarizes tool inputs without raw html payloads", () => {
    expect(
      summarizeToolInput("show_html", {
        title: "Usage chart",
        html: `<html>${"x".repeat(1000)}</html>`,
      }),
    ).toEqual({ title: "Usage chart" });
  });

  test("keeps bounded Write and Edit previews for compact timeline cards", () => {
    const write = summarizeToolInput("Write", {
      file_path: `/tmp/${"a".repeat(100)}/report.md`,
      content: "large body ".repeat(100),
      message: "large message ".repeat(100),
      text: "large text ".repeat(100),
    });
    expect(write).toMatchObject({
      file_path: `/tmp/${"a".repeat(47)}...${"a".repeat(18)}/report.md`,
      lines: 1,
    });
    expect(String(write?.preview)).toStartWith("large body");
    expect(String(write?.preview).length).toBeLessThanOrEqual(90);

    expect(
      summarizeToolInput("Edit", {
        file_path: "/workspace/src/app.ts",
        old_string: "const status = 'old';",
        new_string: "const status = 'new';",
      }),
    ).toEqual({
      file_path: "/workspace/src/app.ts",
      before: "const status = 'old';",
      after: "const status = 'new';",
    });
  });

  test("keeps AskUserQuestion fields needed by the client choice card", () => {
    expect(
      summarizeToolInput("AskUserQuestion", {
        question: "Deploy now?",
        choices: [{ label: "Yes", description: "Ship the current version" }, { label: "No" }],
        internal: { raw: true },
      }),
    ).toEqual({
      question: "Deploy now?",
      choices: [{ label: "Yes", description: "Ship the current version" }, { label: "No" }],
    });
  });

  test("keeps bounded session communication details for client timelines", () => {
    expect(
      summarizeToolInput("mcp__session-comm__ask_session", {
        to: "review",
        message: "Check the current diff for regressions.",
      }),
    ).toEqual({
      to: "review",
      message: "Check the current diff for regressions.",
    });

    const summary = summarizeToolInput("mcp__session-comm__tell_session", {
      to: "research",
      message: "Investigate this independently. ".repeat(10),
    });
    expect(String(summary?.message).length).toBeLessThanOrEqual(90);
  });
});
