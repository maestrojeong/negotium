import { describe, expect, test } from "bun:test";
import { isTriggered, renderBacklogPrompt } from "@/trigger";

describe("isTriggered", () => {
  test("matches the trigger word case-insensitively anywhere in the text", () => {
    expect(isTriggered("lumi 안녕", "lumi")).toBe(true);
    expect(isTriggered("LUMI 안녕", "lumi")).toBe(true);
    expect(isTriggered("오늘 Lumi한테 물어볼게", "lumi")).toBe(true);
  });

  test("does not match when the word is absent", () => {
    expect(isTriggered("안녕하세요", "lumi")).toBe(false);
  });

  test("never matches on an empty/whitespace-only trigger word", () => {
    expect(isTriggered("anything at all", "")).toBe(false);
    expect(isTriggered("anything at all", "   ")).toBe(false);
  });
});

describe("renderBacklogPrompt", () => {
  test("wraps the backlog with a context instruction", () => {
    const prompt = renderBacklogPrompt([
      { authorName: "kakao:1", text: "안녕", createdAt: "2026-01-01T00:00:00Z" },
      { authorName: "kakao:1", text: "lumi 뭐해", createdAt: "2026-01-01T00:00:05Z" },
    ]);
    expect(prompt).toContain("kakao:1: 안녕");
    expect(prompt).toContain("kakao:1: lumi 뭐해");
    expect(prompt).toContain("대화 맥락일 뿐");
  });

  test("drops the oldest lines first when over budget, keeping the tail intact", () => {
    const backlog = Array.from({ length: 50 }, (_, i) => ({
      authorName: "kakao:1",
      text: `message ${i}`,
      createdAt: "2026-01-01T00:00:00Z",
    }));
    const prompt = renderBacklogPrompt(backlog, 200);
    expect(prompt).toContain("message 49"); // newest, must survive truncation
    expect(prompt).not.toContain("message 0"); // oldest, must be dropped first
    expect(prompt.length).toBeLessThan(600); // instruction header + trimmed body
  });

  test("always keeps at least the single most recent line, even under a tiny budget", () => {
    const backlog = [
      { authorName: "kakao:1", text: "a".repeat(50), createdAt: "" },
      { authorName: "kakao:1", text: "b".repeat(50), createdAt: "" },
    ];
    const prompt = renderBacklogPrompt(backlog, 10);
    expect(prompt).toContain("b".repeat(50));
    expect(prompt).not.toContain("a".repeat(50));
  });
});
