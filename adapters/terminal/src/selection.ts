import { displayWidth, stripAnsi } from "@/terminal-width";

export interface ScreenPoint {
  /** One-based terminal column. */
  x: number;
  /** One-based terminal row. */
  y: number;
}

export interface ScreenSelection {
  anchor: ScreenPoint;
  focus: ScreenPoint;
}

function ordered(selection: ScreenSelection): [ScreenPoint, ScreenPoint] {
  const { anchor, focus } = selection;
  return anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)
    ? [anchor, focus]
    : [focus, anchor];
}

/**
 * Zero-width code points belong to the cell in front of them.
 *
 * A combining mark, a variation selector or a ZWJ occupies no column of its
 * own, so column arithmetic alone cannot place it: `"éx"` written as
 * `e U+0301 x` has its accent at the same column as the `e`. Selecting that one
 * cell used to yield a bare `"e"` — the accent was dropped on the way to the
 * clipboard, which is silent data loss, and the same reasoning applies to the
 * inverse-video highlight.
 *
 * This is a selection-range decision only. Widths themselves stay code-point
 * based (`displayWidth`/`runeWidth`), because moving the renderer to grapheme
 * clusters is a separate, deferred change and every width caller has to move at
 * once or rows start disagreeing about how wide they are.
 */
function attachesToPreviousCell(character: string): boolean {
  return displayWidth(character) === 0;
}

function columnSlice(value: string, from: number, to: number): string {
  let output = "";
  let column = 0;
  // A mark before any base character belongs to a notional cell 0.
  let lastIncluded = from <= 0 && to > 0;
  for (const character of stripAnsi(value)) {
    if (attachesToPreviousCell(character)) {
      if (lastIncluded) output += character;
      continue;
    }
    // Checked before consuming the character, so trailing marks on the last
    // selected cell are still picked up above.
    if (column >= to) break;
    const width = displayWidth(character);
    const next = column + width;
    lastIncluded = next > from && column < to;
    if (lastIncluded) output += character;
    column = next;
  }
  return output;
}

/** Extract the text covered by an inclusive, screen-coordinate drag. */
export function screenSelectionText(lines: string[], selection: ScreenSelection): string {
  const [start, end] = ordered(selection);
  const selected: string[] = [];
  for (let row = start.y; row <= end.y; row += 1) {
    const value = lines[row - 1] ?? "";
    const from = row === start.y ? Math.max(0, start.x - 1) : 0;
    const to = row === end.y ? Math.max(from, end.x) : Number.POSITIVE_INFINITY;
    selected.push(columnSlice(value, from, to).trimEnd());
  }
  return selected.join("\n").replace(/\n+$/, "");
}

// Matches a CSI sequence or an OSC 8 hyperlink sequence (see render.ts's
// `hyperlink()`) so both are skipped as zero-width instead of being walked
// character-by-character, which would otherwise miscount columns and corrupt
// the escape bytes whenever a selection overlaps a hyperlinked URL.
// biome-ignore lint/complexity/useRegexLiterals: avoids a control character in a regex literal.
const ANSI_PATTERN = new RegExp(
  "\\u001b\\]8;[^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)|\\u001b\\[[0-?]*[ -/]*[@-~]",
  "y",
);

function highlightRow(value: string, from: number, to: number): string {
  let output = "";
  let column = 0;
  let inverse = false;
  let index = 0;
  let lastSelected = from <= 0 && to > 0;
  while (index < value.length) {
    ANSI_PATTERN.lastIndex = index;
    const ansi = ANSI_PATTERN.exec(value);
    if (ansi) {
      output += ansi[0];
      index += ansi[0].length;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const width = displayWidth(character);
    // A combining mark inherits the highlight of the cell it decorates instead
    // of being range-tested on a column it does not occupy — otherwise the
    // inverse video stops one accent short of the selection.
    const selected = attachesToPreviousCell(character)
      ? lastSelected
      : column + width > from && column < to;
    lastSelected = selected;
    if (selected && !inverse) {
      output += "\u001b[7m";
      inverse = true;
    } else if (!selected && inverse) {
      output += "\u001b[27m";
      inverse = false;
    }
    output += character;
    column += width;
    index += character.length;
  }
  return inverse ? `${output}\u001b[27m` : output;
}

/** Add inverse-video highlighting without changing the frame's plain text. */
export function highlightScreenSelection(frame: string, selection: ScreenSelection): string {
  const [start, end] = ordered(selection);
  return frame
    .split("\n")
    .map((line, index) => {
      const row = index + 1;
      if (row < start.y || row > end.y) return line;
      const from = row === start.y ? Math.max(0, start.x - 1) : 0;
      const to = row === end.y ? Math.max(from, end.x) : Number.POSITIVE_INFINITY;
      return highlightRow(line, from, to);
    })
    .join("\n");
}
