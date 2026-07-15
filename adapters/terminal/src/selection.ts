import { displayWidth, stripAnsi } from "@/render";

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

function columnSlice(value: string, from: number, to: number): string {
  let output = "";
  let column = 0;
  for (const character of stripAnsi(value)) {
    const width = displayWidth(character);
    const next = column + width;
    if (next > from && column < to) output += character;
    column = next;
    if (column >= to) break;
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

// biome-ignore lint/complexity/useRegexLiterals: avoids a control character in a regex literal.
const ANSI_PATTERN = new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "y");

function highlightRow(value: string, from: number, to: number): string {
  let output = "";
  let column = 0;
  let inverse = false;
  let index = 0;
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
    const selected = column + width > from && column < to;
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
