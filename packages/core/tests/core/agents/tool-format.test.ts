import { describe, expect, test } from "bun:test";
import { formatToolUse, summarizeToolInput } from "#agents/tool-format";

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
});
