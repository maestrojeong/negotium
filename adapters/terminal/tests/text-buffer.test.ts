import { describe, expect, test } from "bun:test";
import { InputHistory, TextBuffer } from "@/text-buffer";

describe("terminal text buffer", () => {
  test("edits Korean and emoji by Unicode code point", () => {
    const buffer = new TextBuffer("가😀나");
    buffer.moveLeft();
    buffer.backspace();
    expect(buffer.text).toBe("가나");
    expect(buffer.cursor).toEqual({ row: 0, col: 1 });
  });

  test("inserts and joins multiline text", () => {
    const buffer = new TextBuffer("hello world");
    for (let index = 0; index < 5; index += 1) buffer.moveLeft();
    buffer.insert("\nwide");
    expect(buffer.lines).toEqual(["hello ", "wideworld"]);
    expect(buffer.cursor).toEqual({ row: 1, col: 4 });
    buffer.moveHome();
    buffer.backspace();
    expect(buffer.text).toBe("hello wideworld");
  });

  test("keeps a preferred column while moving across short lines", () => {
    const buffer = new TextBuffer("12345\nx\n12345");
    buffer.moveUp();
    expect(buffer.cursor).toEqual({ row: 1, col: 1 });
    buffer.moveUp();
    expect(buffer.cursor).toEqual({ row: 0, col: 5 });
  });

  test("treats Hangul and Latin as separate word runs", () => {
    const buffer = new TextBuffer("hello한글 world");
    buffer.moveWordLeft();
    expect(buffer.cursor.col).toBe(8);
    buffer.moveWordLeft();
    expect(buffer.cursor.col).toBe(5);
    buffer.deleteWordLeft();
    expect(buffer.text).toBe("한글 world");
  });

  test("deletes across line boundaries", () => {
    const buffer = new TextBuffer("one\ntwo");
    buffer.moveHome();
    buffer.backspace();
    expect(buffer.text).toBe("onetwo");
  });
});

describe("terminal input history", () => {
  test("navigates older entries and restores the unfinished draft", () => {
    const history = new InputHistory(["first", "second"]);
    expect(history.previous("draft")).toBe("second");
    expect(history.previous("ignored")).toBe("first");
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("draft");
  });

  test("deduplicates adjacent submissions", () => {
    const history = new InputHistory();
    history.record("same");
    history.record("same");
    expect(history.entries).toEqual(["same"]);
  });
});
