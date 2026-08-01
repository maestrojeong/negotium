import { describe, expect, test } from "bun:test";
import type { TopicDto } from "@negotium/core";
import {
  displayWidth,
  renderAppFrame,
  setColorDepth,
  wrapLineWithCursor,
  wrapText,
} from "@/render";
import { createInitialState, selectTopic, setTopics } from "@/state";
import { runeWidth } from "@/terminal-width";

setColorDepth("truecolor");

const SAMPLES: Record<string, string> = {
  english: "The quick brown fox jumps over the lazy dog beside a very calm riverbank",
  hangul:
    "한국어는 단어 사이에 공백이 거의 없어서 문자 단위로 접히지 않으면 한 줄에 다 들어가 버린다",
  mixed: "negotium 터미널 adapter 의 wrapText 를 word boundary 기준으로 바꾸는 작업 입니다",
  emoji: "status 🎉 ok ✅ then 👨‍👩‍👧 family and ￦12000 total",
  url: "see https://github.com/openai/codex/pull/34216/files#diff-0123456789abcdef now",
  spaces: "gap    here     and        more",
  hyphens: "word-break-with-hyphens-everywhere-and-then-some",
  single: "supercalifragilisticexpialidocious",
};

const WIDTHS = [2, 3, 5, 8, 12, 20, 37, 64];

const isSpace = (character: string): boolean => character === " " || character === "\t";

/**
 * Independent oracle: walk the *rendered rows* and hand every source code point
 * the screen cell it ended up in, allowing only whitespace to be dropped. This
 * deliberately re-derives the mapping from the rows alone, so it cannot agree
 * with `wrapLineWithCursor` by construction.
 */
function positionsFromRows(text: string, rows: string[]): ({ row: number; col: number } | null)[] {
  const chars = Array.from(text);
  const positions: ({ row: number; col: number } | null)[] = chars.map(() => null);
  let index = 0;
  rows.forEach((row, rowIndex) => {
    let col = 0;
    for (const character of Array.from(row)) {
      while (index < chars.length && chars[index] !== character) {
        expect(isSpace(chars[index] ?? "")).toBe(true);
        index += 1;
      }
      expect(index).toBeLessThan(chars.length);
      positions[index] = { row: rowIndex, col };
      col += runeWidth(character);
      index += 1;
    }
  });
  while (index < chars.length) {
    expect(isSpace(chars[index] ?? "")).toBe(true);
    index += 1;
  }
  return positions;
}

describe("wrapText word boundaries", () => {
  test("folds western prose between words instead of mid-word", () => {
    expect(wrapText("The quick brown fox jumps over the lazy dog", 20)).toEqual([
      "The quick brown fox ",
      "jumps over the lazy ",
      "dog",
    ]);
  });

  test("packs Hangul by character, since it offers no space to fold on", () => {
    const rows = wrapText("한국어는 공백 없이 이어지는 문장이라 문자 단위로 접혀야 한다", 20);
    expect(rows.length).toBeGreaterThan(1);
    // A space-only rule would leave the long space-free runs unfoldable and
    // produce rows far narrower than the column budget.
    for (const row of rows.slice(0, -1)) expect(displayWidth(row)).toBeGreaterThanOrEqual(19);
  });

  test("force-splits a token longer than the row rather than overflowing", () => {
    const rows = wrapText("https://example.com/a/very/long/path/that/never/breaks", 16);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(16);
    expect(rows.join("")).toBe("https://example.com/a/very/long/path/that/never/breaks");
  });

  test("keeps the separator space on the row that is ending", () => {
    // The next row must never open with the space that caused the fold.
    expect(wrapText("hello world", 5)).toEqual(["hello", "world"]);
    expect(wrapText("hello     world", 5)).toEqual(["hello", "world"]);
  });

  test("may fold after a hyphen", () => {
    expect(wrapText("alpha-beta gamma", 11)).toEqual(["alpha-beta ", "gamma"]);
  });

  test("does not strand closing punctuation at the start of a row", () => {
    // Without kinsoku the CJK fold would put the full stop alone on row 2.
    const rows = wrapText("한국어 문장은 문자 단위로 접힙니다.", 20);
    for (const row of rows) expect(row.startsWith(".")).toBe(false);
    expect(rows[rows.length - 1]).toEndWith("다.");
  });

  test("never emits a row wider than the requested width", () => {
    for (const text of Object.values(SAMPLES)) {
      for (const width of WIDTHS) {
        for (const row of wrapText(text, width)) {
          expect(displayWidth(row)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("loses no characters other than fold whitespace", () => {
    for (const text of Object.values(SAMPLES)) {
      for (const width of WIDTHS) {
        const rows = wrapText(text, width);
        expect(rows.join("").replaceAll(/[ \t]/g, "")).toBe(text.replaceAll(/[ \t]/g, ""));
      }
    }
  });
});

describe("wrapLineWithCursor stays consistent with the rows it produced", () => {
  test("agrees with the rendered rows at every offset, for every sample and width", () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
      const length = Array.from(text).length;
      for (const width of WIDTHS) {
        const baseline = wrapText(text, width);
        for (let offset = 0; offset <= length; offset += 1) {
          const label = `${name} w=${width} offset=${offset}`;
          const wrapped = wrapLineWithCursor(text, offset, width);
          // The rows the composer draws must be the same rows `wrapText` draws
          // into the transcript; a divergence here is the classic "cursor is on
          // a line the renderer never produced" bug.
          expect(wrapped.rows, label).toEqual(baseline);
          expect(wrapped.line, label).toBeGreaterThanOrEqual(0);
          expect(wrapped.line, label).toBeLessThan(wrapped.rows.length);
          expect(wrapped.column, label).toBeGreaterThanOrEqual(0);
          expect(wrapped.column, label).toBeLessThanOrEqual(width);

          if (width < 2) continue;
          const positions = positionsFromRows(text, wrapped.rows);
          if (offset === length) {
            expect(wrapped.line, label).toBe(wrapped.rows.length - 1);
            expect(wrapped.column, label).toBe(
              Math.min(width, displayWidth(wrapped.rows[wrapped.rows.length - 1] ?? "")),
            );
            continue;
          }
          const expected = positions[offset];
          if (expected) {
            // The cursor sits exactly on the cell that holds the character it
            // precedes — this is the cell the Hangul IME anchors preedit to.
            expect({ row: wrapped.line, col: wrapped.column }, label).toEqual(expected);
          } else {
            // Offset landed inside whitespace that the fold swallowed; it must
            // still resolve onto the row that owns it, parked at its edge.
            const previous = positions
              .slice(0, offset)
              .filter((entry): entry is { row: number; col: number } => entry !== null)
              .pop();
            expect(wrapped.line, label).toBe(previous ? previous.row : 0);
          }
        }
      }
    }
  });

  test("resolves an offset sitting exactly on a fold to the start of the next row", () => {
    // "hello world" at width 5 folds after the space; offset 6 is the "w".
    expect(wrapLineWithCursor("hello world", 6, 5)).toEqual({
      rows: ["hello", "world"],
      line: 1,
      column: 0,
    });
    // Offset 5 is the swallowed space itself: it belongs to the row that ended.
    expect(wrapLineWithCursor("hello world", 5, 5)).toMatchObject({ line: 0, column: 5 });
  });

  test("clamps out-of-range offsets instead of running off the last row", () => {
    expect(wrapLineWithCursor("abc", -4, 10)).toMatchObject({ line: 0, column: 0 });
    expect(wrapLineWithCursor("abc", 99, 10)).toMatchObject({ line: 0, column: 3 });
  });
});

function composerState(input: string, col: number, row = 0) {
  let state = createInitialState("me");
  state = setTopics(state, [
    {
      id: "topic",
      title: "Terminal",
      kind: "public",
      agent: "codex",
      defaultModel: "gpt",
      defaultEffort: "medium",
    } as unknown as TopicDto,
  ]);
  state = selectTopic(state, "topic");
  return { ...state, input, inputCursor: { row, col } };
}

describe("composer cursor placement", () => {
  test("keeps the hardware cursor on screen for every offset of every sample", () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
      const length = Array.from(text).length;
      for (const columns of [20, 44, 80]) {
        for (let offset = 0; offset <= length; offset += 1) {
          const frame = renderAppFrame(composerState(text, offset), columns, 20);
          const label = `${name} cols=${columns} offset=${offset}`;
          expect(frame.cursor, label).not.toBeNull();
          expect(frame.cursor?.x ?? 0, label).toBeGreaterThanOrEqual(1);
          expect(frame.cursor?.x ?? 0, label).toBeLessThanOrEqual(columns);
          expect(frame.cursor?.y ?? 0, label).toBeGreaterThanOrEqual(1);
          expect(frame.cursor?.y ?? 0, label).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  test("anchors the cursor on the wrapped Hangul cell the caret precedes", () => {
    // Two rows of Hangul in a 44-column composer; the caret before the first
    // character of the second row must land at that row's first column.
    const text = SAMPLES.hangul ?? "";
    const contentWidth = 44 - 5;
    const rows = wrapText(text, contentWidth);
    expect(rows.length).toBeGreaterThan(1);
    const positions = positionsFromRows(text, rows);
    const offset = positions.findIndex((entry) => entry?.row === 1 && entry.col === 0);
    expect(offset).toBeGreaterThan(0);
    const wrapped = wrapLineWithCursor(text, offset, contentWidth);
    expect(wrapped.line).toBe(1);
    expect(wrapped.column).toBe(0);
    // …and the character it precedes really is the first one drawn on row 1.
    expect(Array.from(text)[offset]).toBe(Array.from(rows[1] ?? "")[0]);
  });

  test("places the caret on later logical lines of a multi-line composer", () => {
    const state = composerState("first line\nsecond much longer line here", 6, 1);
    const frame = renderAppFrame(state, 44, 20);
    expect(frame.cursor).not.toBeNull();
    expect(frame.frame).toContain("second");
  });
});
