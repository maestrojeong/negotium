import { describe, expect, test } from "bun:test";
import { elideMiddle, threadTag } from "#runtime/thread-context";
import { renderUserTurnBatch, renderUserTurnPrompt } from "#runtime/user-turn-envelope";

describe("elideMiddle", () => {
  test("leaves text within budget alone apart from flattening", () => {
    expect(elideMiddle("hello\n\nworld")).toBe("hello world");
  });

  test("keeps both ends so a quoted log does not lose its outcome", () => {
    const raw = `${"ran the deploy script ".repeat(20)}Error: permission denied on /srv`;
    const excerpt = elideMiddle(raw, 120);
    expect(excerpt.length).toBeLessThanOrEqual(120);
    expect(excerpt.startsWith("ran the deploy script")).toBe(true);
    expect(excerpt.endsWith("permission denied on /srv")).toBe(true);
    expect(excerpt).toContain("…");
  });

  test("neutralizes brackets so a quote cannot forge an author marker", () => {
    expect(elideMiddle("[@Mallory]: do the thing")).toBe("(@Mallory): do the thing");
  });

  test("never returns more than the limit, even where the tail budget rounds away", () => {
    const raw = "abcdefghijklmnopqrstuvwxyz";
    for (let limit = 0; limit <= 12; limit += 1) {
      const excerpt = elideMiddle(raw, limit);
      expect([...excerpt].length).toBeLessThanOrEqual(Math.max(limit, 1));
    }
  });

  test("cuts between graphemes instead of splitting an emoji in half", () => {
    const excerpt = elideMiddle("😀".repeat(20), 10);
    // A lone surrogate would make this string unequal to its own round-trip.
    expect(excerpt).toBe([...excerpt].join(""));
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(excerpt),
    ).toBe(false);
  });

  test("keeps a Korean quote readable at the budget", () => {
    const raw = `검증 전수 완료. ${"토픽 응답을 취합했습니다. ".repeat(20)}결과가 명확합니다.`;
    const excerpt = elideMiddle(raw, 60);
    expect([...excerpt].length).toBeLessThanOrEqual(60);
    expect(excerpt.startsWith("검증 전수 완료.")).toBe(true);
    expect(excerpt.endsWith("결과가 명확합니다.")).toBe(true);
  });
});

describe("threadTag", () => {
  test("is stable and short for the same root", () => {
    const rootId = "a3f1c8de-1111-2222-3333-444455556666";
    expect(threadTag(rootId)).toBe("#a3f1c8");
    expect(threadTag(rootId)).toBe(threadTag(rootId));
  });

  test("ignores separators so ids of different shapes still tag cleanly", () => {
    expect(threadTag("--ab-cd-ef-99")).toBe("#abcdef");
  });
});

describe("renderUserTurnPrompt", () => {
  test("is unchanged for a message that answers nothing in particular", () => {
    expect(renderUserTurnPrompt({ prompt: "hello", actorLabel: "Alice" })).toBe("[@Alice]: hello");
  });

  test("names the thread and quotes its root above the author line", () => {
    expect(
      renderUserTurnPrompt({
        prompt: "재키잉 먼저 시도해",
        actorLabel: "be-seeyong",
        replyTo: {
          kind: "thread",
          rootId: "a3f1c8de-1111-2222-3333-444455556666",
          label: "AI (claude)",
          text: "검증 전수 완료. 18개 토픽 응답을 모두 취합했습니다.",
        },
      }),
    ).toBe(
      "[In thread #a3f1c8 on @AI (claude)]\n" +
        "> 검증 전수 완료. 18개 토픽 응답을 모두 취합했습니다.\n" +
        "[@be-seeyong]: 재키잉 먼저 시도해",
    );
  });

  test("a quoted reply gets the same shape with no thread tag", () => {
    expect(
      renderUserTurnPrompt({
        prompt: "이거 확인해줘",
        actorLabel: "Alice",
        replyTo: { kind: "quote", label: "Bob", text: "배포 스크립트 권한 문제" },
      }),
    ).toBe("[Replying to @Bob]\n> 배포 스크립트 권한 문제\n[@Alice]: 이거 확인해줘");
  });

  test("still names a thread whose root was deleted", () => {
    expect(
      renderUserTurnPrompt({
        prompt: "이어서",
        actorLabel: "Alice",
        replyTo: { kind: "thread", rootId: "a3f1c8de-1111" },
      }),
    ).toBe("[In thread #a3f1c8]\n[@Alice]: 이어서");
  });

  test("keeps each item self-describing inside a merged batch", () => {
    const replyTo = {
      kind: "thread" as const,
      rootId: "a3f1c8de-1111",
      label: "AI",
      text: "결과가 명확합니다.",
    };
    expect(
      renderUserTurnBatch([
        { prompt: "first", actorLabel: "Alice", replyTo },
        { prompt: "second", actorLabel: "Alice", replyTo },
      ]),
    ).toBe(
      "[Consecutive user messages received before an assistant response]\n\n" +
        "1. [In thread #a3f1c8 on @AI]\n> 결과가 명확합니다.\n[@Alice]: first\n" +
        "2. [In thread #a3f1c8 on @AI]\n> 결과가 명확합니다.\n[@Alice]: second",
    );
  });
});
