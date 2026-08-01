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
    // An empty draft imposes no prefix filter, so every entry is visited.
    expect(history.previous("")).toBe("second");
    expect(history.previous("ignored")).toBe("first");
    expect(history.next()).toBe("second");
    expect(history.next()).toBe("");
  });

  test("deduplicates adjacent submissions", () => {
    const history = new InputHistory();
    history.record("same");
    history.record("same");
    expect(history.entries).toEqual(["same"]);
  });

  test("walks only entries matching the draft prefix", () => {
    const history = new InputHistory(["git status", "bun test", "git commit", "ls"]);

    expect(history.previous("git ")).toBe("git commit");
    expect(history.searchPrefix).toBe("git ");
    expect(history.previous("ignored")).toBe("git status");
    // No older "git " entry exists, so the traversal stops instead of wrapping.
    expect(history.previous("ignored")).toBeNull();
    expect(history.next()).toBe("git commit");
    expect(history.next()).toBe("git ");
    expect(history.next()).toBeNull();
  });

  test("keeps the prefix filter fixed for the whole traversal", () => {
    const history = new InputHistory(["alpha one", "beta", "alpha two"]);

    expect(history.previous("alpha")).toBe("alpha two");
    expect(history.previous("alpha two")).toBe("alpha one");
    expect(history.next()).toBe("alpha two");
    expect(history.next()).toBe("alpha");
  });

  test("falls back to walking every entry when the draft is empty", () => {
    const history = new InputHistory(["one", "two"]);

    expect(history.previous("")).toBe("two");
    expect(history.searchPrefix).toBe("");
    expect(history.previous("")).toBe("one");
    expect(history.next()).toBe("two");
    expect(history.next()).toBe("");
  });

  test("clears the prefix filter after a submission or reset", () => {
    const history = new InputHistory(["one", "two"]);

    expect(history.previous("t")).toBe("two");
    history.reset();
    expect(history.searchPrefix).toBe("");
    expect(history.previous("")).toBe("two");

    history.record("three");
    expect(history.searchPrefix).toBe("");
    expect(history.previous("")).toBe("three");
  });

  test("searches on the text before the caret but restores the whole draft", () => {
    const history = new InputHistory(["git status", "bun test"]);

    // Caret after "git st" inside the draft "git stash": the draft as a whole
    // matches nothing, so Up used to do nothing at all.
    expect(history.previous("git stash", "git st")).toBe("git status");
    expect(history.searchPrefix).toBe("git st");
    // Walking back down restores what the user actually had typed, not the
    // truncated search prefix.
    expect(history.next()).toBe("git stash");
  });

  test("uses the caret prefix from a multi-line draft, not the following lines", () => {
    const buffer = new TextBuffer("git stash\nsecond line");
    buffer.setText("git stash\nsecond line", { row: 0, col: 6 });
    expect(buffer.textBeforeCursor).toBe("git st");

    const history = new InputHistory(["git status"]);
    expect(history.previous(buffer.text, buffer.textBeforeCursor)).toBe("git status");
    expect(history.next()).toBe("git stash\nsecond line");
  });

  test("a caret at the very start walks the whole history", () => {
    const buffer = new TextBuffer("zzz");
    buffer.setText("zzz", "start");
    expect(buffer.textBeforeCursor).toBe("");

    const history = new InputHistory(["one", "two"]);
    expect(history.previous(buffer.text, buffer.textBeforeCursor)).toBe("two");
    expect(history.next()).toBe("zzz");
  });

  test("restores the draft caret, not just the draft text", () => {
    // Walking back down used to hand the text back with the caret dumped at the
    // end, silently moving the edit point on a multi-line draft.
    const buffer = new TextBuffer();
    buffer.setText("git stash\nsecond line", { row: 0, col: 6 });
    const history = new InputHistory(["git status"]);

    expect(history.previous(buffer.text, buffer.textBeforeCursor, buffer.cursor)).toBe(
      "git status",
    );
    // A history entry has no caret of its own: it lands at the end, like typing.
    expect(history.atDraft).toBe(false);

    expect(history.next()).toBe("git stash\nsecond line");
    expect(history.atDraft).toBe(true);
    expect(history.draftCursor).toEqual({ row: 0, col: 6 });
  });

  test("carries the draft caret through several history steps", () => {
    const history = new InputHistory(["one", "two", "three"]);
    for (const cursor of [
      { row: 0, col: 0 },
      { row: 0, col: 2 },
      { row: 1, col: 4 },
    ]) {
      history.reset();
      expect(history.previous("ab\ncdef", "", cursor)).toBe("three");
      expect(history.previous("ignored", "")).toBe("two");
      expect(history.next()).toBe("three");
      expect(history.next()).toBe("ab\ncdef");
      expect(history.draftCursor).toEqual(cursor);
    }
  });

  test("forgets the draft caret once the traversal is over", () => {
    const history = new InputHistory(["one"]);
    history.previous("draft", "", { row: 0, col: 1 });
    history.reset();
    expect(history.draftCursor).toBeUndefined();

    // A traversal started without a caret reports none rather than a stale one.
    expect(history.previous("draft", "")).toBe("one");
    expect(history.next()).toBe("draft");
    expect(history.draftCursor).toBeUndefined();
  });

  test("clamps a restored caret that no longer fits the buffer", () => {
    const buffer = new TextBuffer();
    buffer.setText("a longer draft", { row: 0, col: 9 });
    buffer.setText("short", { row: 0, col: 9 });
    expect(buffer.cursor).toEqual({ row: 0, col: 5 });
  });

  test("leaves the draft untouched when no entry matches the prefix", () => {
    const history = new InputHistory(["one", "two"]);

    expect(history.previous("zzz")).toBeNull();
    expect(history.next()).toBeNull();
  });
});
