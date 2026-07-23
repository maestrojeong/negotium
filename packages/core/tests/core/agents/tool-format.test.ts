import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyShellToolName,
  formatToolUse,
  summarizeShellCommand,
  summarizeToolInput,
} from "#agents/tool-format";

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

  test("classifies only simple read-only shell commands as Read or Search", () => {
    expect(classifyShellToolName("sed -n '1,80p' src/app.ts")).toBe("Read");
    expect(classifyShellToolName("cat package.json")).toBe("Read");
    expect(classifyShellToolName("rg -n 'needle' src")).toBe("Search");
    expect(classifyShellToolName("find src -name '*.ts'")).toBe("Search");
    expect(classifyShellToolName("sed -i '' 's/a/b/' src/app.ts")).toBe("Bash");
    expect(classifyShellToolName("sed --in-place=.bak 's/a/b/' src/app.ts")).toBe("Bash");
    expect(classifyShellToolName("sed -n -e 'w output' input")).toBe("Bash");
    expect(classifyShellToolName("find src -delete")).toBe("Bash");
    expect(classifyShellToolName("find src -fprint output")).toBe("Bash");
    expect(classifyShellToolName("cat input.txt > output.txt")).toBe("Bash");
    expect(classifyShellToolName("rg needle src | head")).toBe("Bash");
    expect(classifyShellToolName("cat notes.txt\nrm -rf /tmp/example")).toBe("Bash");
    expect(classifyShellToolName('bash -lc "cat notes.txt\nrm -rf /tmp/example"')).toBe("Bash");

    expect(formatToolUse("Read", { command: "sed -n '1,80p' src/app.ts" })).toBe("Read(app.ts)");
    expect(formatToolUse("Search", { command: "rg -n 'needle' src" })).toBe("Search(needle +1)");
    expect(formatToolUse("Bash", { command: "cat package.json" })).toBe("Read(package.json)");
    expect(formatToolUse("Bash", { command: "rg -n 'needle' src" })).toBe("Search(needle +1)");
    expect(formatToolUse("Bash", { command: "cat input.txt > output.txt" })).toBe(
      "Bash(cat input.txt +1)",
    );
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
    expect(String(write?.preview).length).toBeLessThanOrEqual(4_000);

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

    expect(
      summarizeToolInput("Edit", {
        file_path: "/workspace/example.py",
        before: "  old_value  \n",
        after: "  new_value  \n",
      }),
    ).toMatchObject({
      before: "  old_value  \n",
      after: "  new_value  \n",
    });

    expect(
      summarizeToolInput("Edit", {
        file_path: "/workspace/src/app.ts",
        change_kind: "update",
        before: "const first = 1;\nconst second = 2;",
        after: "const first = 10;\nconst second = 20;",
        diff_preview:
          "12 -const first = 1;\n12 +const first = 10;\n13 -const second = 2;\n13 +const second = 20;",
      }),
    ).toEqual({
      file_path: "/workspace/src/app.ts",
      change_kind: "update",
      before: "const first = 1;\nconst second = 2;",
      after: "const first = 10;\nconst second = 20;",
      diff_preview:
        "12 -const first = 1;\n12 +const first = 10;\n13 -const second = 2;\n13 +const second = 20;",
    });

    expect(
      summarizeToolInput("Write", {
        file_path: "/workspace/src/new.ts",
        after: "first line\nsecond line\n",
        diff_preview: "1 +first line\n2 +second line",
      }),
    ).toEqual({
      file_path: "/workspace/src/new.ts",
      preview: "first line\nsecond line\n",
      lines: 2,
      diff_preview: "1 +first line\n2 +second line",
    });

    expect(
      summarizeToolInput("Delete", {
        file_path: "/workspace/src/old.ts",
        before: "first line\nsecond line",
        diff_preview: "1 -first line\n2 -second line",
      }),
    ).toEqual({
      file_path: "/workspace/src/old.ts",
      before: "first line\nsecond line",
      diff_preview: "1 -first line\n2 -second line",
    });
  });

  test("generates one numbered file diff for Claude and Maestro tool inputs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "negotium-tool-diff-"));
    try {
      writeFileSync(join(cwd, "example.py"), "first\nsecond\n  new_value  \nfourth\n");
      expect(
        summarizeToolInput(
          "Edit",
          {
            file_path: "example.py",
            old_string: "  old_value  \n",
            new_string: "  new_value  \n",
          },
          { cwd },
        ),
      ).toMatchObject({
        before: "  old_value  \n",
        after: "  new_value  \n",
        diff_preview: "3 -  old_value  \n3 +  new_value  ",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
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
