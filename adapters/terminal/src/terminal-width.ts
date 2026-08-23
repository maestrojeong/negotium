export function stripAnsi(value: string): string {
  return (
    value
      // OSC 8 hyperlinks (`ESC ] 8 ; params ; URI ST ... ESC ] 8 ; ; ST`) are not
      // CSI sequences, so they must be stripped separately before the CSI
      // pattern below — otherwise their zero-width escape bytes would count as
      // printable characters and corrupt selection copy / width math.
      // biome-ignore lint/complexity/useRegexLiterals: avoids literal terminal control bytes in source.
      .replace(new RegExp("\\u001b\\]8;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)", "g"), "")
      // biome-ignore lint/complexity/useRegexLiterals: avoids literal terminal control bytes in source.
      .replace(new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g"), "")
  );
}

/**
 * Non-spacing and enclosing marks occupy no column of their own. Only the
 * blocks that actually reach a terminal are probed, so the (comparatively
 * slow) Unicode property test stays off the hot path for ASCII and Hangul.
 */
const COMBINING_PROBE_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], // Combining Diacritical Marks (NFD Latin)
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e3a],
  [0x0f71, 0x0f87],
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x20d0, 0x20f0], // Combining Diacritical Marks for Symbols
  [0x302a, 0x302f], // CJK / Hangul tone marks
  [0x3099, 0x309a], // Kana voiced sound marks
  [0xfe20, 0xfe2f], // Combining Half Marks
];

const NON_SPACING_MARK = /^[\p{Mn}\p{Me}]$/u;

/**
 * East Asian Wide / Fullwidth code points that fall outside the large CJK
 * blocks below. Mostly Unicode-Emoji default-presentation symbols from the
 * Miscellaneous Symbols / Dingbats blocks, which a plain `< 0x1f300` check
 * would size as one column and desynchronise the whole row.
 */
function isWideSymbol(code: number): boolean {
  return (
    (code >= 0x231a && code <= 0x231b) ||
    (code >= 0x23e9 && code <= 0x23ec) ||
    code === 0x23f0 ||
    code === 0x23f3 ||
    (code >= 0x25fd && code <= 0x25fe) ||
    (code >= 0x2614 && code <= 0x2615) ||
    (code >= 0x2648 && code <= 0x2653) ||
    code === 0x267f ||
    code === 0x2693 ||
    code === 0x26a1 ||
    (code >= 0x26aa && code <= 0x26ab) ||
    (code >= 0x26bd && code <= 0x26be) ||
    (code >= 0x26c4 && code <= 0x26c5) ||
    code === 0x26ce ||
    code === 0x26d4 ||
    code === 0x26ea ||
    (code >= 0x26f2 && code <= 0x26f3) ||
    code === 0x26f5 ||
    code === 0x26fa ||
    code === 0x26fd ||
    code === 0x2705 ||
    (code >= 0x270a && code <= 0x270b) ||
    code === 0x2728 ||
    code === 0x274c ||
    code === 0x274e ||
    (code >= 0x2753 && code <= 0x2755) ||
    code === 0x2757 ||
    (code >= 0x2795 && code <= 0x2797) ||
    code === 0x27b0 ||
    code === 0x27bf ||
    (code >= 0x2b1b && code <= 0x2b1c) ||
    code === 0x2b50 ||
    code === 0x2b55
  );
}

/**
 * Conjoining Hangul medials (jungseong) and finals (jongseong): they compose
 * onto the preceding initial consonant, so they occupy no column of their own.
 *
 * They are not `\p{Mn}` — Unicode classifies them as letters — so the combining
 * probe above cannot find them, and their East Asian Width is Neutral rather
 * than Wide. Only `wcwidth` (and every terminal that follows it) sizes them at
 * zero, and the terminal is what this measurement has to agree with.
 *
 * Load-bearing on macOS: HFS+/APFS return filenames in NFD, so any dragged-in
 * path containing Hangul ("스크린샷 …") arrives here decomposed. Left at one
 * column each, a four-syllable name over-measures by six columns, which pads
 * the row short and pushes the composer's hardware cursor past the text.
 *
 * Scoped to the base block on purpose. Initials (choseong, U+1100–U+115F and
 * Extended-A U+A960–U+A97F) stay wide: they are the base the rest composes
 * onto. Extended-B (U+D7B0–U+D7FF) is the same class of jamo and arguably
 * belongs here too, but it stays wide because terminals disagree about it and
 * the only observed break involves the base block; see the Extended-B case in
 * `terminal-width.test.ts`.
 */
function isConjoiningJamo(code: number): boolean {
  return code >= 0x1160 && code <= 0x11ff;
}

function isWideBlock(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f || // Hangul Jamo (initial consonants)
      code === 0x2329 ||
      code === 0x232a ||
      isWideSymbol(code) ||
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals … Yi
      (code >= 0xa960 && code <= 0xa97f) || // Hangul Jamo Extended-A
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
      (code >= 0xd7b0 && code <= 0xd7ff) || // Hangul Jamo Extended-B
      (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
      (code >= 0xfe10 && code <= 0xfe6f) || // Vertical forms / small forms
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
      (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth signs incl. ￦
      (code >= 0x16fe0 && code <= 0x16fff) || // Ideographic symbols
      (code >= 0x17000 && code <= 0x18aff) || // Tangut / Khitan
      (code >= 0x1b000 && code <= 0x1b16f) || // Kana supplements
      (code >= 0x1f200 && code <= 0x1f2ff) || // Enclosed ideographic supplement
      (code >= 0x1f300 && code <= 0x1faff) || // Emoji planes
      code >= 0x20000) // CJK extension B and beyond
  );
}

const widthCache = new Map<number, number>();
const WIDTH_CACHE_LIMIT = 4096;

function widthOfCode(code: number): number {
  // Control characters keep width 1 (as before): callers strip them through
  // `safeText` first, and treating them as zero here would make the code-point
  // based composer cursor disagree with the measured line width.
  if (code < 0x0300) return 1;
  if (code === 0x200b || code === 0x200d || code === 0xfeff) return 0;
  if (code >= 0xfe00 && code <= 0xfe0f) return 0;
  if (isConjoiningJamo(code)) return 0;
  // Marks are probed before the wide blocks: several of them (Combining Half
  // Marks, CJK tone marks, kana sound marks) sit inside otherwise-wide ranges.
  for (const [start, end] of COMBINING_PROBE_RANGES) {
    if (code < start) break;
    if (code <= end && NON_SPACING_MARK.test(String.fromCodePoint(code))) return 0;
  }
  return isWideBlock(code) ? 2 : 1;
}

export function runeWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const cached = widthCache.get(code);
  if (cached !== undefined) return cached;
  const width = widthOfCode(code);
  if (widthCache.size >= WIDTH_CACHE_LIMIT) widthCache.clear();
  widthCache.set(code, width);
  return width;
}

/**
 * Sum of `runeWidth` over the printable code points.
 *
 * Deliberately code-point based, exactly like `sliceWidth`/`wrapText` in the
 * renderer and the code-point cursor in the text buffer. A grapheme-cluster
 * measure (which would let U+FE0F widen its base glyph, or collapse a ZWJ
 * sequence to two columns) is only safe once every one of those callers moves
 * to clusters together; disagreeing measures would re-introduce over-wide rows.
 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) width += runeWidth(char);
  return width;
}
