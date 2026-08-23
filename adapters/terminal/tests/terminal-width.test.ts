import { describe, expect, test } from "bun:test";
import { displayWidth, runeWidth, stripAnsi } from "@/terminal-width";

describe("runeWidth", () => {
  test("keeps ASCII and Latin at one column", () => {
    expect(runeWidth("a")).toBe(1);
    expect(runeWidth(" ")).toBe(1);
    expect(runeWidth("é")).toBe(1);
    expect(displayWidth("hello")).toBe(5);
  });

  test("counts Hangul syllables and CJK ideographs as two columns", () => {
    expect(runeWidth("한")).toBe(2);
    expect(runeWidth("漢")).toBe(2);
    expect(runeWidth("あ")).toBe(2);
    expect(displayWidth("a한b")).toBe(4);
  });

  test("measures decomposed Hangul exactly like the composed form", () => {
    // macOS returns filenames in NFD, so a dragged-in path arrives with every
    // syllable split into conjoining jamo. The terminal composes them back into
    // one cell per syllable, so both spellings must measure the same: the
    // initial carries the two columns and the medial/final carry none.
    expect(runeWidth("ᄉ")).toBe(2); // Choseong (initial): the base cell
    expect(runeWidth("ᅳ")).toBe(0); // Jungseong (medial)
    expect(runeWidth("ᆫ")).toBe(0); // Jongseong (final)

    const composed = "스크린샷 2026-08-23 오전 7.16.37.png";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    expect(displayWidth(decomposed)).toBe(displayWidth(composed));
    expect(displayWidth(decomposed)).toBe(36);
  });

  test("counts Hangul Jamo Extended blocks as two columns", () => {
    // Extended-A (U+A960..A97F) and Extended-B (U+D7B0..D7FF) are emitted by
    // some IMEs while a syllable is still being composed.
    expect(runeWidth("ꥠ")).toBe(2);
    expect(runeWidth("ꥼ")).toBe(2);
    expect(runeWidth("ힰ")).toBe(2);
    expect(runeWidth("퟿")).toBe(2);
  });

  test("counts fullwidth signs beyond U+FF60, including the won sign", () => {
    expect(runeWidth("￦")).toBe(2);
    expect(runeWidth("￥")).toBe(2);
    expect(runeWidth("￡")).toBe(2);
    expect(displayWidth("￦1,000")).toBe(7);
  });

  test("counts default-emoji symbols below U+1F300 as two columns", () => {
    for (const emoji of ["✅", "❌", "❎", "⚡", "⌚", "⏰", "⭐", "⭕", "➕", "❓", "❗", "✨"]) {
      expect([emoji, runeWidth(emoji)]).toEqual([emoji, 2]);
    }
  });

  test("still counts text-presentation dingbats as one column", () => {
    // These are East Asian Neutral/Narrow; widening them would over-count the
    // renderer's own bullet and check glyphs.
    for (const symbol of ["✓", "✗", "→", "·", "●", "○", "↳", "─", "│", "╭"]) {
      expect([symbol, runeWidth(symbol)]).toEqual([symbol, 1]);
    }
  });

  test("counts emoji planes as two columns", () => {
    expect(runeWidth("🙂")).toBe(2);
    expect(runeWidth("🧩")).toBe(2);
    expect(runeWidth("𠀋")).toBe(2);
  });

  test("gives combining marks zero width", () => {
    // NFD "가" = U+1100 U+1161 (jamo, wide) — and NFD Latin "é" = e + U+0301.
    expect(runeWidth("́")).toBe(0);
    expect(runeWidth("ͯ")).toBe(0);
    expect(runeWidth("⃣")).toBe(0);
    expect(runeWidth("︠")).toBe(0);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("café")).toBe(4);
  });

  test("gives zero-width joiners and variation selectors zero width", () => {
    expect(runeWidth("‍")).toBe(0);
    expect(runeWidth("️")).toBe(0);
    expect(runeWidth("​")).toBe(0);
    expect(runeWidth("﻿")).toBe(0);
    // A ZWJ family stays the sum of its bases, matching wcwidth terminals.
    expect(displayWidth("👨‍👩‍👧")).toBe(6);
  });

  test("counts a regional indicator flag as two columns", () => {
    expect(displayWidth("🇰🇷")).toBe(2);
    expect(displayWidth("🇰🇷🇯🇵")).toBe(4);
  });

  test("ignores ANSI styling and OSC 8 hyperlinks when measuring", () => {
    expect(displayWidth("[31mred[0m")).toBe(3);
    expect(displayWidth("]8;;https://example.comlink]8;;")).toBe(4);
    expect(stripAnsi("[1mbold[0m")).toBe("bold");
  });

  test("measures the same string consistently across repeated calls", () => {
    // runeWidth memoizes by code point; a stale cache would desynchronise rows.
    const sample = "한글 ✅ ￦ é 🙂";
    const first = displayWidth(sample);
    for (let index = 0; index < 3; index += 1) expect(displayWidth(sample)).toBe(first);
  });
});
