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

  test("keeps tool_call summaries small and drops body-like fields", () => {
    expect(
      summarizeToolInput("Write", {
        file_path: `/tmp/${"a".repeat(100)}/report.md`,
        content: "large body ".repeat(100),
        message: "large message ".repeat(100),
        text: "large text ".repeat(100),
      }),
    ).toEqual({
      file_path: `/tmp/${"a".repeat(47)}...${"a".repeat(18)}/report.md`,
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
