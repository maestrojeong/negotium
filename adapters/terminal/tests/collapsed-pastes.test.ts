import { describe, expect, test } from "bun:test";
import { pasteCollapseDisabled } from "@/app-helpers";
import {
  COLLAPSED_PASTE_MIN_CHARS,
  COLLAPSED_PASTE_MIN_LINES,
  CollapsedPasteStore,
  cursorForTextOffset,
  shouldCollapsePaste,
  textOffsetForCursor,
} from "@/collapsed-pastes";
import { createInitialState } from "@/state";

describe("collapsed terminal pastes", () => {
  test("collapses pastes at either threshold and leaves short input visible", () => {
    expect(shouldCollapsePaste("x".repeat(COLLAPSED_PASTE_MIN_CHARS - 1))).toBe(false);
    expect(shouldCollapsePaste("x".repeat(COLLAPSED_PASTE_MIN_CHARS))).toBe(true);
    expect(
      shouldCollapsePaste(
        Array(COLLAPSED_PASTE_MIN_LINES - 1)
          .fill("line")
          .join("\n"),
      ),
    ).toBe(false);
    expect(shouldCollapsePaste(Array(COLLAPSED_PASTE_MIN_LINES).fill("line").join("\n"))).toBe(
      true,
    );

    const store = new CollapsedPasteStore();
    expect(store.insert("short paste", "", 0).text).toBe("short paste");
  });

  test("restores intact labels only when submitting", () => {
    const original = `header\n${"body".repeat(150)}`;
    const store = new CollapsedPasteStore();
    const inserted = store.insert(original, "before  after", 7);

    expect(inserted.text).toBe("before ‹[Pasted 607 chars]› after");
    expect(store.expand(inserted.text)).toBe(`before ${original} after`);
  });

  test("editing or deleting a label discards its hidden original", () => {
    const original = "x".repeat(COLLAPSED_PASTE_MIN_CHARS);
    const store = new CollapsedPasteStore();
    const inserted = store.insert(original, "", 0);
    const edited = inserted.text.replace("Pasted", "Edited");

    store.reconcile(edited);

    expect(store.expand(edited)).toBe(edited);
  });

  test("keeps same-sized pastes independently addressable", () => {
    const first = "a".repeat(COLLAPSED_PASTE_MIN_CHARS);
    const second = "b".repeat(COLLAPSED_PASTE_MIN_CHARS);
    const store = new CollapsedPasteStore();
    const firstInsert = store.insert(first, "", 0);
    const separated = store.insert("\n", firstInsert.text, firstInsert.cursorOffset);
    const secondInsert = store.insert(second, separated.text, separated.cursorOffset);

    expect(secondInsert.text).toBe("‹[Pasted 500 chars]›\n‹[Pasted 500 chars #2]›");
    expect(store.expand(secondInsert.text)).toBe(`${first}\n${second}`);
  });

  test("does not expand a manually typed duplicate label at another position", () => {
    const original = "x".repeat(COLLAPSED_PASTE_MIN_CHARS);
    const store = new CollapsedPasteStore();
    const inserted = store.insert(original, "prefix ", 7);
    const duplicate = "‹[Pasted 500 chars]›";
    const edited = `${duplicate} ${inserted.text}`;

    store.reconcile(edited);

    expect(store.expand(edited)).toBe(`${duplicate} prefix ${original}`);
  });

  test("converts multiline Unicode cursors to stable code-point offsets", () => {
    const text = "한글\nA😀B";
    const cursor = { row: 1, col: 2 };
    const offset = textOffsetForCursor(text, cursor);

    expect(offset).toBe(5);
    expect(cursorForTextOffset(text, offset)).toEqual(cursor);
  });

  test("disables collapsing for topic names and Vault screens", () => {
    const state = createInitialState("local");
    expect(pasteCollapseDisabled(state)).toBe(false);
    expect(pasteCollapseDisabled({ ...state, creatingTopic: true })).toBe(true);
    expect(pasteCollapseDisabled({ ...state, overlay: "vault" })).toBe(true);
  });
});
