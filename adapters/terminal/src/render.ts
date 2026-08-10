import {
  EFFORT_VALUES,
  getRegistry,
  type MessageDto,
  resolveModelForAgent,
  SELECTABLE_MODELS,
  type TopicDto,
} from "@negotium/core";
import { terminalNowMs } from "@/clock";
import { type ColorDepth, detectColorDepth, rgbToAnsi16, rgbToAnsi256 } from "@/color-depth";
import { commandSuggestions } from "@/commands";
import { activeContextBreakdown } from "@/context-usage";
import { pathSuggestions } from "@/path-suggest";
import {
  type AppState,
  activeMessages,
  activeQuestion,
  activeTaskPanel,
  activeTopic,
  type NoticeLevel,
  pickedBackgroundSession,
  type TerminalMessage,
  visibleBackgroundSessions,
  visibleTopicPickerIds,
} from "@/state";
import { displayWidth, runeWidth, stripAnsi } from "@/terminal-width";

export { displayWidth, stripAnsi } from "@/terminal-width";

type Rgb = readonly [number, number, number];

const theme = {
  canvas: [10, 11, 15] as Rgb,
  surface: [18, 20, 27] as Rgb,
  surfaceRaised: [24, 27, 36] as Rgb,
  selected: [42, 37, 69] as Rgb,
  border: [48, 52, 67] as Rgb,
  borderActive: [119, 103, 239] as Rgb,
  taskBorder: [151, 118, 56] as Rgb,
  text: [232, 233, 239] as Rgb,
  muted: [137, 141, 158] as Rgb,
  subtle: [91, 95, 112] as Rgb,
  accent: [139, 124, 246] as Rgb,
  cyan: [87, 205, 220] as Rgb,
  tool: [196, 181, 253] as Rgb,
  green: [94, 211, 142] as Rgb,
  diffAddBg: [18, 43, 32] as Rgb,
  amber: [241, 190, 91] as Rgb,
  red: [245, 116, 128] as Rgb,
  diffRemoveBg: [45, 22, 28] as Rgb,
};

// cli-spinners' compact "dots" pattern: fast, stable-width, and reads as
// active computation rather than a slow mechanical wheel.
const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const CODE_COPY_MARKER = "⧉";
export const WORKING_FRAME_INTERVAL_MS = 50;

export function workingFrame(frame: number): string {
  const index = Math.abs(Math.trunc(frame)) % WORKING_FRAMES.length;
  return WORKING_FRAMES[index] ?? WORKING_FRAMES[0];
}

function workingElapsedSeconds(startedAtMs: number | undefined, nowMs = terminalNowMs()): number {
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}

export function formatElapsedDuration(totalSeconds: number): string {
  const elapsed = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const days = Math.floor(elapsed / 86_400);
  const hours = Math.floor((elapsed % 86_400) / 3_600);
  const minutes = Math.floor((elapsed % 3_600) / 60);
  const seconds = elapsed % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Hide legacy cross-agent defaults such as codex + deepseek-pro. */
export function effectiveTopicModel(topic: TopicDto | null): string {
  if (!topic?.agent) return topic?.defaultModel ?? "-";
  return resolveModelForAgent(
    topic.agent,
    topic.effectiveModel ?? topic.defaultModel,
    getRegistry(topic.agent),
  );
}

function effectiveTopicEffort(topic: TopicDto | null): string {
  return topic?.effectiveEffort ?? topic?.defaultEffort ?? "-";
}

interface UiSpan {
  text: string;
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
}

interface UiLine {
  text: string;
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
  spans?: UiSpan[];
  codeCopy?: string;
}

export interface CodeCopyTarget {
  xStart: number;
  xEnd: number;
  y: number;
  text: string;
}

export interface RenderedTerminalApp {
  frame: string;
  cursor: { x: number; y: number } | null;
  codeCopyTargets: CodeCopyTarget[];
}

const ESC = "\u001b[";
const RESET = `${ESC}0m`;
/**
 * Detected once at module load. The palette above is authored in 24-bit RGB;
 * `fg`/`bg` downshift it to whatever the terminal accepts, and `"none"` drops
 * every SGR byte so a pipe, `NO_COLOR`, or `TERM=dumb` gets plain text.
 *
 * Because every severity/state distinction in the UI also carries a glyph
 * (`NOTICE_STYLE`, `toolMessageLines`, `toolDetailSign`), `"none"` loses
 * emphasis but not information.
 */
let colorDepth: ColorDepth = detectColorDepth();

export function getColorDepth(): ColorDepth {
  return colorDepth;
}

/**
 * Runtime override (tests, and any caller applying `NEGOTIUM_TUI_COLOR` after
 * module load). Clears the message layout cache: layouts are cached as
 * unpainted `UiLine` values today, so depth does not actually leak into them,
 * but the invalidation must exist regardless of that internal detail.
 */
export function setColorDepth(depth: ColorDepth): void {
  if (depth === colorDepth) return;
  colorDepth = depth;
  clearMessageLayoutCache();
}

const fg = (rgb: Rgb): string => {
  switch (colorDepth) {
    case "none":
      return "";
    case "ansi16": {
      const code = rgbToAnsi16(rgb);
      return `${ESC}${code < 8 ? 30 + code : 90 + (code - 8)}m`;
    }
    case "ansi256":
      return `${ESC}38;5;${rgbToAnsi256(rgb)}m`;
    default:
      return `${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  }
};

const bg = (rgb: Rgb): string => {
  switch (colorDepth) {
    case "none":
      return "";
    case "ansi16": {
      const code = rgbToAnsi16(rgb);
      return `${ESC}${code < 8 ? 40 + code : 100 + (code - 8)}m`;
    }
    case "ansi256":
      return `${ESC}48;5;${rgbToAnsi256(rgb)}m`;
    default:
      return `${ESC}48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  }
};

function paint(
  value: string,
  options: { fg?: Rgb; bg?: Rgb; bold?: boolean; dim?: boolean } = {},
): string {
  // `none` emits no SGR at all - including the trailing reset, so the frame is
  // byte-for-byte plain text rather than text wrapped in no-op escapes.
  if (colorDepth === "none") return value;
  return `${options.fg ? fg(options.fg) : ""}${options.bg ? bg(options.bg) : ""}${options.bold ? `${ESC}1m` : ""}${options.dim ? `${ESC}2m` : ""}${value}${RESET}`;
}

// OSC 8 hyperlinks (https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda).
// Terminals that understand the sequence make the wrapped text clickable;
// most terminals that don't simply ignore the escape bytes. "Most" is why this
// is gated on `colorDepth !== "none"` below rather than emitted unconditionally.
// `stripAnsi` (terminal-width.ts) strips it back out for width math and
// selection copy, so it must stay in sync with this format.
function hyperlink(url: string, label: string): string {
  return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007`;
}

// Bare `https?://` URLs that show up in agent output or tool results (plain
// paragraphs, markdown-link parens from `cleanInlineMarkdown`, code blocks,
// etc). Run once over the fully composed frame — after wrapping/fitting have
// already fixed every line's visual width — because the inserted escape
// bytes are zero-width and must not perturb any width calculation upstream.
// biome-ignore lint/complexity/useRegexLiterals: avoids a literal terminal control byte in source.
const BARE_URL_PATTERN = new RegExp("\\bhttps?://[^\\s<>\"'`\\u001b]+", "g");
// Trailing characters that are almost always punctuation around the URL
// rather than part of it (closing paren from markdown, sentence-ending
// punctuation, etc).
const URL_TRAILING_PUNCTUATION = /[).,;:!?\]}'"]+$/;

/**
 * Wraps bare URLs in OSC 8, except at colour depth `none`.
 *
 * `none` is the contract "this frame is plain text": it is what `NO_COLOR` and
 * `TERM=dumb` resolve to, and both mean "the thing reading me may not speak
 * escape sequences at all". A terminal that ignores SGR but not OSC 8 would
 * print the raw `]8;;https://…` bytes as visible garbage, and a pipe or a
 * screen reader has no use for them either. Hyperlinks are folded into the
 * colour capability rather than given their own flag: negotium has no way to
 * probe OSC 8 support separately, so a second flag would only be a second thing
 * to guess wrong.
 */
function linkifyUrls(text: string): string {
  if (colorDepth === "none") return text;
  return text.replace(BARE_URL_PATTERN, (match) => {
    const trailingMatch = match.match(URL_TRAILING_PUNCTUATION);
    const trailing = trailingMatch ? trailingMatch[0] : "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (!url) return match;
    return `${hyperlink(url, url)}${trailing}`;
  });
}

function safeText(value: string): string {
  return [...stripAnsi(value).replaceAll("\r", "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
}

function sliceWidth(value: string, width: number): string {
  let out = "";
  let used = 0;
  for (const char of [...safeText(value)]) {
    const next = runeWidth(char);
    if (used + next > width) break;
    out += char;
    used += next;
  }
  return out;
}

function sliceWidthRange(value: string, start: number, width: number): string {
  let out = "";
  let column = 0;
  for (const char of [...safeText(value)]) {
    const charWidth = runeWidth(char);
    const end = column + charWidth;
    if (end > start && column < start + width) {
      if (column < start) out += " ".repeat(Math.min(charWidth, start - column));
      else if (end <= start + width) out += char;
    }
    column = end;
    if (column >= start + width) break;
  }
  return sliceWidth(out, width);
}

function replaceAtDisplayColumn(value: string, targetColumn: number, replacement: string): string {
  let out = "";
  let column = 0;
  let replaced = false;
  for (const char of [...safeText(value)]) {
    const charWidth = runeWidth(char);
    if (!replaced && column === targetColumn) {
      out += replacement;
      replaced = true;
    } else {
      out += char;
    }
    column += charWidth;
  }
  return out;
}

function graphLineSpans(
  value: string,
  start: number,
  width: number,
  highlightedColumns: ReadonlySet<number>,
  baseColor: Rgb,
): UiSpan[] {
  const visible = sliceWidthRange(value, start, width);
  const spans: UiSpan[] = [{ text: "  ", fg: baseColor }];
  let column = 0;
  let currentText = "";
  let currentHighlighted: boolean | undefined;
  const flush = (): void => {
    if (!currentText) return;
    spans.push({
      text: currentText,
      fg: currentHighlighted ? theme.amber : baseColor,
      bold: currentHighlighted,
    });
    currentText = "";
  };
  for (const char of [...visible]) {
    const charWidth = runeWidth(char);
    const highlighted = Array.from(
      { length: Math.max(1, charWidth) },
      (_, offset) => start + column + offset,
    ).some((candidate) => highlightedColumns.has(candidate));
    if (currentHighlighted !== undefined && highlighted !== currentHighlighted) flush();
    currentHighlighted = highlighted;
    currentText += char;
    column += charWidth;
  }
  flush();
  return spans;
}

function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const clean = safeText(value).replaceAll("\n", " ");
  const clipped = sliceWidth(clean, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

function joinSides(left: string, right: string, width: number): string {
  const safeLeft = sliceWidth(left, width);
  const remaining = Math.max(1, width - displayWidth(safeLeft));
  const safeRight = sliceWidth(right, remaining);
  const gap = Math.max(1, width - displayWidth(safeLeft) - displayWidth(safeRight));
  return fit(`${safeLeft}${" ".repeat(gap)}${safeRight}`, width);
}

/**
 * Port of codex's `usable_content_width` (codex-rs/tui/src/width.rs): fixed
 * prefix columns are only spent when a usable content width survives them.
 * Returns `null` when the caller should drop the prefix (or itself) instead of
 * forcing a layout that cannot fit.
 */
function usableContentWidth(
  totalWidth: number,
  reservedColumns: number,
  minimum = 1,
): number | null {
  const remaining = totalWidth - reservedColumns;
  return remaining >= minimum ? remaining : null;
}

/**
 * Greedy fit test over a priority-ordered list of candidates, mirroring the
 * drop chain in codex's `bottom_pane/footer.rs`: try the richest text first and
 * fall back to progressively shorter ones instead of switching on a global
 * "narrow terminal" breakpoint. The last candidate is used even if it still
 * overflows, because the caller truncates it anyway.
 */
function pickFitting(candidates: readonly string[], width: number): string {
  for (const candidate of candidates) {
    if (displayWidth(candidate) <= width) return candidate;
  }
  return candidates[candidates.length - 1] ?? "";
}

/**
 * One visual row of a wrapped paragraph, expressed as code-point offsets into
 * the paragraph rather than as a string.
 *
 * `[start, end)` is every code point the row *owns* — including whitespace that
 * was swallowed at the fold and is not drawn. `[start, textEnd)` is what is
 * actually rendered. The two differ only when a fold lands inside a run of
 * spaces; keeping both means the wrapper and the cursor mapper agree on which
 * row an offset belongs to even for characters that leave no visible mark.
 */
interface WrapSegment {
  start: number;
  end: number;
  textEnd: number;
}

const isWrapSpace = (character: string): boolean => character === " " || character === "\t";

/**
 * Scripts without spaces (Hangul, Han, kana, and — harmlessly — emoji) are all
 * double-width here, so "is this two columns wide" doubles as "may a line fold
 * on either side of this character". Without it, Korean text has no break
 * opportunity at all and would only ever fold by force.
 */
const isWideBreak = (character: string): boolean => runeWidth(character) === 2;

/**
 * Minimal kinsoku: characters that must not open a row (closing brackets and
 * trailing punctuation) and characters that must not close one (opening
 * brackets). Without this, folding "…접힙니다." on a CJK boundary strands the
 * full stop alone on the next row, which is the most visible artefact of
 * character-level CJK folding.
 *
 * Advisory only — the force split that rescues an over-long token ignores it,
 * so this can never keep a row from fitting.
 */
const NO_ROW_START = new Set(
  Array.from(
    ".,;:!?)]}>»”’\u3001\u3002\uff0c\uff0e\uff01\uff1f\uff1a\uff1b\uff09\uff3d\uff5d\u3009\u300b\u300d\u300f\u3011\u3015\u30fb\u2026\u30fc",
  ),
);
const NO_ROW_END = new Set(
  Array.from("([{<«“‘\uff08\uff3b\uff5b\u3008\u300a\u300c\u300e\u3010\u3014"),
);

/** May a row end immediately before `index`? */
function breaksBefore(chars: readonly string[], index: number): boolean {
  const previous = chars[index] === undefined ? "" : (chars[index - 1] ?? "");
  const current = chars[index] ?? "";
  if (NO_ROW_START.has(current) || NO_ROW_END.has(previous)) return false;
  if (isWrapSpace(previous) && !isWrapSpace(current)) return true;
  if (isWideBreak(previous) || isWideBreak(current)) return true;
  return previous === "-" && !isWrapSpace(current);
}

/**
 * Greedy word wrap over code points.
 *
 * Rules, in the order they apply:
 *  1. Fold at the last break opportunity that still fits — after a whitespace
 *     run, on either side of a double-width (CJK/emoji) character, or after a
 *     hyphen. Western words therefore stay intact and Korean keeps packing the
 *     row as tightly as the old character wrap did.
 *  2. A token longer than the whole row (a URL, a hash) is force-split at the
 *     column limit. Without this the row would outgrow the terminal and break
 *     the width invariant that the line-diff renderer depends on.
 *  3. When the character that overflows is whitespace, the entire whitespace
 *     run is absorbed by the row that is ending and clipped away at render
 *     time, so the next row never begins with the separator space.
 *
 * Everything is measured with `runeWidth` per code point, deliberately matching
 * `displayWidth`/`sliceWidth`/the text buffer's cursor; a grapheme-cluster
 * measure here alone would resurrect over-wide rows on narrow terminals.
 */
function wrapSegments(chars: readonly string[], width: number): WrapSegment[] {
  const total = chars.length;
  if (total === 0) return [{ start: 0, end: 0, textEnd: 0 }];
  const segments: WrapSegment[] = [];
  let start = 0;
  while (start < total) {
    let used = 0;
    let lastBreak = -1;
    let index = start;
    for (; index < total; index++) {
      // Recorded before the fit test: a row may legally end *after* a character
      // that itself no longer fits' predecessor, e.g. the space in "한국어 테스트".
      if (index > start && breaksBefore(chars, index)) lastBreak = index;
      const characterWidth = runeWidth(chars[index] ?? "");
      if (used + characterWidth > width && index > start) break;
      used += characterWidth;
    }
    if (index >= total) {
      segments.push({ start, end: total, textEnd: total });
      break;
    }
    if (isWrapSpace(chars[index] ?? "")) {
      let after = index;
      while (after < total && isWrapSpace(chars[after] ?? "")) after += 1;
      segments.push({ start, end: after, textEnd: index });
      start = after;
      continue;
    }
    const end = lastBreak > start ? lastBreak : index;
    segments.push({ start, end, textEnd: end });
    start = end;
  }
  return segments.length > 0 ? segments : [{ start: 0, end: 0, textEnd: 0 }];
}

/**
 * Single row escape hatch for widths too narrow to fold into.
 *
 * At `width <= 1` a double-width code point cannot be placed at all, so any
 * folding would emit a row wider than the terminal. `wrapText` and
 * `wrapLineWithCursor` both take this branch so they stay in agreement.
 */
const WRAP_MIN_WIDTH = 2;

export function wrapText(value: string, width: number): string[] {
  if (width < WRAP_MIN_WIDTH) return [sliceWidth(value, Math.max(0, width))];
  const output: string[] = [];
  for (const paragraph of safeText(value).split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    const chars = Array.from(paragraph);
    for (const segment of wrapSegments(chars, width)) {
      output.push(chars.slice(segment.start, segment.textEnd).join(""));
    }
  }
  return output.length > 0 ? output : [""];
}

function line(text: string, options: Omit<UiLine, "text"> = {}): UiLine {
  return { text, ...options };
}

/**
 * Narrowest inner width a bordered pane is still drawn at. Below it the pane is
 * skipped entirely rather than degraded, matching `card_inner_width()` in
 * codex's `history_cell/session.rs`, which returns `None` under four columns
 * and renders nothing at all. No "terminal too narrow" notice is shown; codex
 * has none either.
 */
const FRAME_MIN_INNER_WIDTH = 4;
/** Below this inner width the border title is dropped to keep content legible. */
const FRAME_TITLE_MIN_INNER_WIDTH = 8;

function framePane(
  title: string,
  content: UiLine[],
  width: number,
  height: number,
  options: { active?: boolean; accent?: Rgb } = {},
): string[] {
  const innerWidth = usableContentWidth(width, 2, FRAME_MIN_INNER_WIDTH);
  if (innerWidth === null) return [];
  const borderColor = options.active ? (options.accent ?? theme.borderActive) : theme.border;
  const labelText =
    innerWidth >= FRAME_TITLE_MIN_INNER_WIDTH ? sliceWidth(title, innerWidth - 3) : "";
  const label = labelText ? ` ${labelText} ` : "";
  // Every row is cut to `innerWidth` before the border is attached (`fit`
  // below, `sliceWidth` for the title). codex PR #34775 fixed exactly this:
  // its `with_border` used to widen the box to the longest line, so the box
  // could exceed the terminal. Truncating first makes that impossible here.
  const top = paint(`╭${label}${"─".repeat(Math.max(0, innerWidth - displayWidth(label)))}╮`, {
    fg: borderColor,
    bg: theme.canvas,
    bold: true,
  });
  const body = Array.from({ length: Math.max(0, height - 2) }, (_, index) => {
    const item = content[index] ?? line("");
    const side = paint("│", { fg: borderColor, bg: theme.canvas });
    const cell = paint(fit(item.text, innerWidth), {
      fg: item.fg ?? theme.text,
      bg: item.bg ?? theme.surface,
      bold: item.bold,
      dim: item.dim,
    });
    return `${side}${cell}${side}`;
  });
  const bottom = paint(`╰${"─".repeat(innerWidth)}╯`, {
    fg: borderColor,
    bg: theme.canvas,
  });
  return [top, ...body, bottom];
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<!\*)\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "‹$1›");
}

interface ParsedTableRow {
  cells: string[];
  hasOuterPipes: boolean;
}

/** Parse unescaped pipes outside inline code spans as table delimiters. */
function parseTableRow(raw: string): ParsedTableRow | null {
  const trimmed = raw.trim();
  if (!trimmed.includes("|")) return null;

  const cells: string[] = [];
  let cell = "";
  let delimiterCount = 0;
  let codeFenceLength = 0;
  let startsWithPipe = false;
  let endsWithPipe = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index] ?? "";
    if (character === "\\") {
      let runLength = 1;
      while (trimmed[index + runLength] === "\\") runLength += 1;
      const next = trimmed[index + runLength];
      cell += "\\".repeat(Math.floor(runLength / 2));
      if (next === "|" && runLength % 2 === 1) {
        cell += "|";
        index += runLength;
      } else {
        if (runLength % 2 === 1) cell += "\\";
        index += runLength - 1;
      }
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (trimmed[index + runLength] === "`") runLength += 1;
      if (codeFenceLength === 0) codeFenceLength = runLength;
      else if (codeFenceLength === runLength) codeFenceLength = 0;
      cell += "`".repeat(runLength);
      index += runLength - 1;
      continue;
    }
    if (character === "|" && codeFenceLength === 0) {
      if (delimiterCount === 0 && cell.trim() === "") startsWithPipe = true;
      cells.push(cell.trim());
      cell = "";
      delimiterCount += 1;
      endsWithPipe = index === trimmed.length - 1;
      continue;
    }
    cell += character;
    endsWithPipe = false;
  }
  if (delimiterCount === 0) return null;
  cells.push(cell.trim());
  if (startsWithPipe) cells.shift();
  if (endsWithPipe) cells.pop();
  if (cells.length === 0) return null;
  return { cells, hasOuterPipes: startsWithPipe && endsWithPipe };
}

function isSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function alignmentFromSeparator(cell: string): "left" | "center" | "right" {
  if (/^:-{3,}:$/.test(cell)) return "center";
  if (/^-{3,}:$/.test(cell)) return "right";
  return "left";
}

/** Maximum table width as fraction of the available column width. */
const TABLE_MAX_WIDTH_FRACTION = 0.92;
/** Minimum column width before a column is dropped with a "…" marker. */
const TABLE_MIN_COL_WIDTH = 4;

function renderTable(rows: string[][], width: number): UiLine[] {
  // Determine header range: if row[1] is a separator, row[0] is the header.
  const hasHeader =
    rows.length >= 2 && rows[1].length > 0 && rows[1].every((cell) => isSeparatorCell(cell));
  const headerRow = hasHeader ? rows[0] : null;
  const separators = hasHeader ? rows[1] : null;
  const bodyStart = hasHeader ? 2 : 0;
  const bodyRows = rows.slice(bodyStart);
  const allRows = [...(headerRow ? [headerRow] : []), ...bodyRows];

  const sourceColCount = Math.max(1, ...allRows.map((row) => row.length), separators?.length ?? 0);
  const innerWidth = Math.max(4, width - 2); // 2-char indent
  const maxTableWidth = Math.max(1, Math.floor(innerWidth * TABLE_MAX_WIDTH_FRACTION));
  const maxVisibleColumns = Math.max(
    1,
    Math.floor((maxTableWidth - 1) / (TABLE_MIN_COL_WIDTH + 3)),
  );
  const hasOmittedColumns = sourceColCount > maxVisibleColumns;
  const colCount = Math.min(sourceColCount, maxVisibleColumns);
  const visibleRow = (row: string[]): string[] => {
    const visible = Array.from({ length: colCount }, (_, index) => row[index] ?? "");
    if (hasOmittedColumns && colCount > 1) visible[colCount - 1] = "…";
    return visible;
  };
  const visibleHeader = headerRow ? visibleRow(headerRow) : null;
  const visibleBodyRows = bodyRows.map(visibleRow);

  // Initial column widths from content.
  const contentWidths = Array.from({ length: colCount }, () => 1);
  for (const row of [...(visibleHeader ? [visibleHeader] : []), ...visibleBodyRows]) {
    for (let index = 0; index < colCount; index += 1) {
      const cell = row[index] ?? "";
      const cleaned = cleanInlineMarkdown(cell);
      contentWidths[index] = Math.max(contentWidths[index], displayWidth(cleaned));
    }
  }

  const totalContent = contentWidths.reduce((sum, w) => sum + w, 0);
  const totalPadding = colCount * 3 + 1; // "│ " + " │" per col + final "│"
  const idealWidth = totalContent + totalPadding;

  // Shrink columns to fit when necessary.
  const colWidths = [...contentWidths];
  if (idealWidth > maxTableWidth) {
    const availableContent = Math.max(colCount, maxTableWidth - totalPadding);
    for (let index = 0; index < colCount; index += 1) {
      colWidths[index] = Math.min(contentWidths[index], TABLE_MIN_COL_WIDTH);
    }
    let remaining = Math.max(
      0,
      availableContent - colWidths.reduce((sum, columnWidth) => sum + columnWidth, 0),
    );
    while (remaining > 0) {
      let widestRemainderIndex = -1;
      let widestRemainder = 0;
      for (let index = 0; index < colCount; index += 1) {
        const remainder = contentWidths[index] - (colWidths[index] ?? 0);
        if (remainder > widestRemainder) {
          widestRemainder = remainder;
          widestRemainderIndex = index;
        }
      }
      if (widestRemainderIndex < 0) break;
      colWidths[widestRemainderIndex] += 1;
      remaining -= 1;
    }
  }

  const alignments = Array.from({ length: colCount }, (_, index) =>
    alignmentFromSeparator(separators?.[index] ?? ""),
  );

  function alignCell(text: string, colWidth: number, align?: string): string {
    const cleaned = cleanInlineMarkdown(text);
    const visual = displayWidth(cleaned);
    if (visual <= colWidth) {
      if (align === "right") return `${" ".repeat(colWidth - visual)}${cleaned}`;
      if (align === "center") {
        const left = Math.floor((colWidth - visual) / 2);
        return `${" ".repeat(left)}${cleaned}${" ".repeat(colWidth - visual - left)}`;
      }
      return fit(cleaned, colWidth); // left
    }
    // Truncate with ellipsis.
    return `${sliceWidth(cleaned, colWidth - 1)}…`;
  }

  const borderColor = theme.border;
  const result: UiLine[] = [];

  const joinRow = (cells: string[]): string => `  │ ${cells.join(" │ ")} │`;
  const border = (left: string, middle: string, right: string): string =>
    `  ${left}${colWidths.map((columnWidth) => "─".repeat(columnWidth + 2)).join(middle)}${right}`;

  // Top border.
  result.push(line(border("┌", "┬", "┐"), { fg: borderColor }));

  // Header row.
  if (visibleHeader) {
    result.push(
      line(
        joinRow(
          Array.from({ length: colCount }, (_, index) =>
            alignCell(visibleHeader[index] ?? "", colWidths[index] ?? 0, alignments[index]),
          ),
        ),
        { fg: theme.accent, bold: true },
      ),
    );
    // Header separator.
    result.push(line(border("├", "┼", "┤"), { fg: borderColor }));
  }

  // Body rows.
  for (const row of visibleBodyRows) {
    result.push(
      line(
        joinRow(
          Array.from({ length: colCount }, (_, index) =>
            alignCell(row[index] ?? "", colWidths[index] ?? 0, alignments[index]),
          ),
        ),
        { fg: theme.text },
      ),
    );
  }

  // Bottom border.
  result.push(line(border("└", "┴", "┘"), { fg: borderColor }));

  return result;
}

/** Lightweight block renderer adapted to agent replies: headings, lists, quotes, fenced code and tables. */
function renderMarkdown(value: string, width: number): UiLine[] {
  const result: UiLine[] = [];
  let codeLanguage = "";
  let inCode = false;
  let codeHeaderIndex = -1;
  let codeLines: string[] = [];
  const finishCodeBlock = () => {
    const header = result[codeHeaderIndex];
    if (header) header.codeCopy = codeLines.join("\n");
    codeHeaderIndex = -1;
    codeLines = [];
  };
  let tableBuffer: string[][] = [];
  let inTable = false;
  const flushTable = () => {
    if (tableBuffer.length > 0) {
      result.push(...renderTable(tableBuffer, width));
      tableBuffer = [];
    }
    inTable = false;
  };
  const rawLines = safeText(value).split("\n");
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    const rawLine = rawLines[lineIndex] ?? "";
    const fence = rawLine.match(/^\s*```([^`]*)$/);
    if (fence) {
      flushTable();
      if (!inCode) {
        codeLanguage = fence[1]?.trim() ?? "";
        codeHeaderIndex = result.length;
        result.push(
          line(`  ┌─ code${codeLanguage ? ` · ${codeLanguage}` : ""}  ${CODE_COPY_MARKER}`, {
            fg: theme.cyan,
            bg: theme.surfaceRaised,
            bold: true,
          }),
        );
      } else {
        result.push(line("  └─", { fg: theme.subtle, bg: theme.surfaceRaised }));
        finishCodeBlock();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      for (const wrapped of wrapText(rawLine || " ", Math.max(4, width - 4))) {
        result.push(line(`  │ ${wrapped}`, { fg: theme.text, bg: theme.surfaceRaised }));
      }
      continue;
    }
    // Table row detection: pipe-delimited cells.
    const parsedTableRow = parseTableRow(rawLine);
    const nextTableRow = parseTableRow(rawLines[lineIndex + 1] ?? "");
    const startsHeaderTable =
      parsedTableRow !== null &&
      parsedTableRow.cells.length >= 2 &&
      nextTableRow !== null &&
      nextTableRow.cells.length === parsedTableRow.cells.length &&
      nextTableRow.cells.every((cell) => isSeparatorCell(cell));
    const startsExplicitTable =
      parsedTableRow?.hasOuterPipes === true && parsedTableRow.cells.length >= 2;
    const tableRow =
      parsedTableRow && (inTable || startsHeaderTable || startsExplicitTable)
        ? parsedTableRow.cells
        : null;
    if (tableRow) {
      if (!inTable) {
        inTable = true;
        tableBuffer = [tableRow];
      } else {
        tableBuffer.push(tableRow);
      }
      continue;
    }
    if (inTable) flushTable();
    const heading = rawLine.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      for (const wrapped of wrapText(cleanInlineMarkdown(heading[2]), Math.max(4, width - 2))) {
        result.push(line(`  ${wrapped}`, { fg: theme.accent, bold: true }));
      }
      continue;
    }
    const bullet = rawLine.match(/^\s*[-+*]\s+(.+)$/);
    if (bullet) {
      for (const [index, wrapped] of wrapText(
        cleanInlineMarkdown(bullet[1]),
        Math.max(4, width - 5),
      ).entries()) {
        result.push(line(`  ${index === 0 ? "•" : " "} ${wrapped}`, { fg: theme.text }));
      }
      continue;
    }
    const ordered = rawLine.match(/^\s*(\d+[.)])\s+(.+)$/);
    if (ordered) {
      const marker = ordered[1];
      for (const [index, wrapped] of wrapText(
        cleanInlineMarkdown(ordered[2]),
        Math.max(4, width - marker.length - 4),
      ).entries()) {
        result.push(line(`  ${index === 0 ? marker : " ".repeat(marker.length)} ${wrapped}`));
      }
      continue;
    }
    const quote = rawLine.match(/^\s*>\s?(.*)$/);
    if (quote) {
      for (const wrapped of wrapText(cleanInlineMarkdown(quote[1]), Math.max(4, width - 5))) {
        result.push(line(`  ▏ ${wrapped}`, { fg: theme.muted }));
      }
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(rawLine)) {
      result.push(line(`  ${"─".repeat(Math.max(1, width - 4))}`, { fg: theme.border }));
      continue;
    }
    if (!rawLine.trim()) {
      result.push(line(""));
      continue;
    }
    for (const wrapped of wrapText(cleanInlineMarkdown(rawLine), Math.max(4, width - 2))) {
      result.push(line(`  ${wrapped}`, { fg: theme.text }));
    }
  }
  if (inTable) flushTable();
  if (inCode) {
    result.push(line("  └─", { fg: theme.subtle, bg: theme.surfaceRaised }));
    finishCodeBlock();
  }
  return result;
}

function subagentLines(message: MessageDto, width: number): UiLine[] {
  const card = message.subagentCard;
  if (!card) return [];
  const done = card.status === "completed";
  const failed = card.status === "failed";
  const color = failed ? theme.red : done ? theme.green : theme.cyan;
  const output = card.errorMessage ?? card.resultSummary ?? card.task;
  return [
    line(`  ↳ ${card.name}  ${card.status}`, { fg: color, bold: true }),
    ...wrapText(output, Math.max(4, width - 6))
      .slice(0, 4)
      .map((text) => line(`    ${text}`, { fg: theme.muted })),
    line(""),
  ];
}

function isVisibleSystemMessage(message: MessageDto): boolean {
  return message.sourceAdapter === "session-comm" || message.id.startsWith("tell-");
}

function toolDetailSign(detail: string): "-" | "+" | undefined {
  // Numbered diff markers have exactly one separator space (`12 -old`).
  // Context lines use two (`12  - list item`), where the following sign is
  // ordinary file content and must not be colored as an addition/removal.
  const marker = /^(?:\d+ )?([+-])/.exec(detail)?.[1];
  return marker === "-" || marker === "+" ? marker : undefined;
}

function toolDetailColor(detail: string): Rgb {
  if (detail.startsWith("!")) return theme.red;
  if (toolDetailSign(detail) === "-") return theme.red;
  if (toolDetailSign(detail) === "+") return theme.green;
  if (detail.startsWith("~")) return theme.amber;
  return theme.muted;
}

function toolDetailBackground(detail: string): Rgb | undefined {
  if (toolDetailSign(detail) === "-") return theme.diffRemoveBg;
  if (toolDetailSign(detail) === "+") return theme.diffAddBg;
  return undefined;
}

function toolHeaderColor(failed: boolean): Rgb {
  if (failed) return theme.red;
  return theme.tool;
}

/** Visual-line budget for a file change preview before "… +N more lines". */
const FILE_PREVIEW_MAX_LINES = 12;

function toolMessageLines(message: TerminalMessage, width: number): UiLine[] {
  const [title = "Tool", ...details] = safeText(message.text).split("\n");
  const failed = message.toolResult === "error";
  const done = failed || Boolean(message.editedAt);
  const fileMutation = /^(?:Edit|Write|Delete) · /.test(title);
  const wrapWidth = Math.max(4, width - 6);
  const marker = failed ? "!" : done ? "✓" : "●";
  const headerText = `  ${marker} ${title}`;
  const stats = title.match(/^(.*?)(\(\+(\d+) -(\d+)\))$/);
  const headerColor = toolHeaderColor(failed);
  const header = line(headerText, {
    fg: headerColor,
    spans: stats
      ? [
          { text: `  ${marker} ${stats[1] ?? ""}(`, fg: headerColor },
          { text: `+${stats[3] ?? "0"}`, fg: theme.green },
          { text: " " },
          { text: `-${stats[4] ?? "0"}`, fg: theme.red },
          { text: ")" },
        ]
      : [{ text: headerText, fg: headerColor }],
  });
  if (!fileMutation) {
    return [
      header,
      ...details.slice(0, 2).flatMap((detail) =>
        wrapText(detail, wrapWidth)
          .slice(0, 1)
          .map((text) => line(`    ${text}`, { fg: toolDetailColor(detail), dim: !failed })),
      ),
    ];
  }
  // File change previews keep every logical line's +/- marker and truncate
  // only on total visual height, with an explicit count of what was hidden.
  const wrapped = details.flatMap((detail) =>
    wrapText(detail, wrapWidth).map((text) => ({ detail, text })),
  );
  const visible = wrapped.slice(0, FILE_PREVIEW_MAX_LINES);
  const hidden = wrapped.length - visible.length;
  return [
    header,
    ...visible.map(({ detail, text }) =>
      line(`    ${text}`, {
        fg: toolDetailColor(detail),
        bg: toolDetailBackground(detail),
        dim: toolDetailSign(detail) === "-",
      }),
    ),
    ...(hidden > 0
      ? [line(`    … +${hidden} more line${hidden === 1 ? "" : "s"}`, { fg: theme.muted })]
      : []),
  ];
}

interface MessageLayout {
  width: number;
  userId: string;
  lines: UiLine[];
}

/**
 * Layout cache for messages that have not changed since the last frame.
 *
 * Every runtime event lays out the whole transcript three times (the frame
 * itself, plus `maxConversationScrollOffset` twice via
 * `preserveConversationScrollAnchor`), and Markdown layout dominates that cost.
 *
 * Keyed by object identity rather than by message content, following codex
 * PR #34223: instead of proving "the content did not change" with a hash, the
 * cache relies on the store already proving it structurally. `upsertMessage`
 * and `patchMessage` in `state.ts` always replace the message object
 * (`next[index] = { ...next[index], ...patch }`) and never mutate one in place,
 * and `activeMessages` hands out the stored objects without copying them. So a
 * surviving reference *is* the proof that nothing changed, and a streaming
 * delta — which allocates a new object per chunk — misses automatically with no
 * need for an explicit "is this message still streaming" flag.
 *
 * Only one slot per message is kept (codex uses `Option<(Key, Lines)>` the same
 * way): a width or viewer change overwrites it. The WeakMap lets dropped
 * messages be collected, so no LRU or size cap is required.
 *
 * Colour depth (see `setColorDepth`) is deliberately *not* part of the key:
 * entries hold unpainted `UiLine` values whose `fg`/`bg` are still raw RGB, and
 * `paint` resolves the depth later in `renderBody`. `setColorDepth` clears this
 * cache anyway, so the two stay correct even if a layout ever starts baking
 * escape bytes in.
 */
let messageLayoutCache = new WeakMap<TerminalMessage, MessageLayout>();

/** Rendered line arrays are treated as immutable; callers only spread or slice. */
function messageLines(message: TerminalMessage, width: number, userId: string): UiLine[] {
  const cached = messageLayoutCache.get(message);
  if (cached && cached.width === width && cached.userId === userId) return cached.lines;
  const lines = renderMessageLines(message, width, userId);
  messageLayoutCache.set(message, { width, userId, lines });
  return lines;
}

/** Escape hatch for tests and for future palette-driven invalidation. */
export function clearMessageLayoutCache(): void {
  messageLayoutCache = new WeakMap();
}

function renderMessageLines(message: TerminalMessage, width: number, userId: string): UiLine[] {
  if (
    message.kind === "system" ||
    (message.authorId === "system" && !isVisibleSystemMessage(message))
  ) {
    return [];
  }
  if (message.kind === "subagent" && message.subagentCard) return subagentLines(message, width);
  if (message.kind === "tool") return toolMessageLines(message, width);
  const own = message.authorId === userId;
  const ai = message.authorId === "ai";
  const icon = own ? "›" : ai ? "●" : "•";
  const body = ai
    ? renderMarkdown(message.text, Math.max(4, width - 6))
    : wrapText(message.text, Math.max(4, width - 6)).map((text, index) =>
        line(`${index === 0 ? `  ${icon} ` : "    "}${text}`, {
          fg: theme.text,
          bg: theme.surfaceRaised,
        }),
      );
  if (ai) {
    const firstContent = body.findIndex((item) => item.text.trim().length > 0);
    if (firstContent >= 0) {
      const first = body[firstContent];
      if (first.codeCopy === undefined) {
        body[firstContent] = {
          ...first,
          text: `  ${icon} ${first.text.trimStart()}`,
        };
      }
    }
  }
  if (!ai) {
    const padding = line("", { bg: theme.surfaceRaised });
    return [padding, ...body, padding, line("")];
  }
  return [...body, line("")];
}

function activityDetail(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("Working…")) return undefined;
  if (raw.startsWith("Thinking…")) return "Thinking";
  const running = raw.match(/^(.*?) running \d+s$/u);
  return running?.[1]?.trim() || raw;
}

function activityLines(state: AppState, animationFrame = 0, nowMs = terminalNowMs()): UiLine[] {
  const topic = activeTopic(state);
  if (!topic) return [];
  const activity = state.activity[topic.id];
  if (!activity) return [];
  const result: UiLine[] = [];
  if (activity.running) {
    const detail = activityDetail(activity.status);
    const lastToolLabel = activity.tools.at(-1)?.label;
    const elapsed = workingElapsedSeconds(activity.startedAtMs, nowMs);
    result.push(
      line(
        `  ${workingFrame(animationFrame)} Working · ${formatElapsedDuration(elapsed)}${detail && detail !== lastToolLabel ? ` · ${detail}` : ""}`,
        { fg: theme.amber, bold: true },
      ),
    );
  } else if (activity.error) {
    result.push(line(`  ! ${activity.error}`, { fg: theme.red }));
  }
  if (result.length > 0) result.push(line(""));
  return result;
}

function taskItems(state: AppState): string[] {
  const taskPanel = activeTaskPanel(state);
  if (!taskPanel) return [];
  const tasks = safeText(taskPanel.text).split("\n").slice(1);
  const active = tasks.filter((task) => /^\s*\[->\]/i.test(task));
  const pending = tasks.filter(
    (task) => !/^\s*\[->\]/i.test(task) && !/^\s*(?:\[x\]|☒|✓|✅)/i.test(task),
  );
  const completed = tasks.filter((task) => /^\s*(?:\[x\]|☒|✓|✅)/i.test(task));
  return [...active, ...pending, ...completed.reverse()];
}

const INLINE_TASK_LIMIT = 5;

function taskLines(state: AppState, width: number): UiLine[] {
  const tasks = taskItems(state);
  if (tasks.length === 0) return [];
  const visibleTasks = tasks.slice(0, INLINE_TASK_LIMIT);
  const hidden = tasks.length - visibleTasks.length;
  return [
    line("  ◫ Tasks · Ctrl-T sidebar", { fg: theme.amber, bold: true }),
    ...visibleTasks.flatMap((task) =>
      wrapText(task.trimStart(), Math.max(4, width - 6)).map((text) =>
        line(`    ${text}`, { fg: theme.muted }),
      ),
    ),
    ...(hidden > 0 ? [line(`    +${hidden} more`, { fg: theme.muted, dim: true })] : []),
    line(""),
  ];
}

const TASK_SIDEBAR_MIN_WIDTH = 110;
const TASK_SIDEBAR_WIDTH = 36;
const TASK_SIDEBAR_GAP = 1;

interface TerminalBodyLayout {
  conversationWidth: number;
  taskWidth: number;
  showTaskSidebar: boolean;
}

function terminalBodyLayout(state: AppState, width: number): TerminalBodyLayout {
  const showTaskSidebar =
    width >= TASK_SIDEBAR_MIN_WIDTH &&
    state.taskSidebarEnabled &&
    !state.overlay &&
    !state.creatingTopic &&
    taskItems(state).length > 0;
  return {
    conversationWidth: showTaskSidebar ? width - TASK_SIDEBAR_WIDTH - TASK_SIDEBAR_GAP : width,
    taskWidth: showTaskSidebar ? TASK_SIDEBAR_WIDTH : 0,
    showTaskSidebar,
  };
}

/**
 * Sidebar task list clipped to the pane height. taskItems() already orders
 * current work first (then pending and latest completed), so overflow drops the
 * oldest finished tasks and is announced with an explicit "+N more" row
 * instead of silently disappearing below the frame.
 */
function taskSidebarLines(state: AppState, width: number, height: number): UiLine[] {
  const items = taskItems(state);
  const groups = items.map((task) => {
    const completed = /^\s*(?:\[x\]|☒|✓|✅)/i.test(task);
    return wrapText(task.trimStart(), Math.max(4, width - 4)).map((text) =>
      line(` ${text}`, {
        fg: completed ? theme.muted : theme.text,
        dim: completed,
      }),
    );
  });
  const capacity = Math.max(1, height);
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  if (total <= capacity) return groups.flat();
  if (capacity === 1) return groups[0]?.slice(0, 1) ?? [];
  const rows: UiLine[] = [];
  let shown = 0;
  for (const group of groups) {
    if (rows.length + group.length > capacity - 1) {
      if (shown === 0) {
        rows.push(...group.slice(0, capacity - 1));
        shown = 1;
      }
      break;
    }
    rows.push(...group);
    shown += 1;
  }
  rows.push(line(` +${items.length - shown} more`, { fg: theme.muted, dim: true }));
  return rows;
}

function helpLines(): UiLine[] {
  return [
    line("  Keyboard", { fg: theme.accent, bold: true }),
    line(""),
    // Shift/Ctrl-Enter only reach us on terminals that honour the kitty
    // keyboard protocol we push; Alt-Enter is the universal fallback.
    line("  Shift-Enter / Ctrl-Enter newline · Alt-Enter always works"),
    line("  ← → move · Ctrl/Alt-← → move by word · ↑ ↓ history"),
    line("  Alt-Backspace delete word · Ctrl-U clear before cursor"),
    line("  Cmd-Backspace works when forwarded · Ctrl-W/K aliases"),
    line("  Mouse wheel / PgUp/PgDn scroll · Ctrl-E load older · Ctrl-T tasks"),
    line("  Ctrl-O topics · Ctrl-G subagents · Ctrl-D decisions · Ctrl-X abort"),
    line("  In topics: type to filter · Ctrl-N new · Ctrl-D delete"),
    line("  Esc/Ctrl-C stop active turn · Ctrl-C twice when idle to quit"),
    line(""),
    line("  Commands", { fg: theme.cyan, bold: true }),
    line("  /new  /model  /effort  /status  /context"),
    line("  /topics  /fork  /spawn"),
    line("  /del  /copy  /abort  /help  /quit", { fg: theme.muted }),
  ];
}

function tokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unavailable";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function latestActiveUsage(state: AppState): MessageDto["usage"] {
  return activeMessages(state)
    .slice()
    .reverse()
    .find((message) => message.authorId === "ai" && message.usage)?.usage;
}

function contextUsageColor(ratio: number | undefined): Rgb {
  if (ratio !== undefined && ratio >= 90) return theme.red;
  if (ratio !== undefined && ratio >= 80) return theme.amber;
  return theme.text;
}

function statusLines(state: AppState): UiLine[] {
  const topic = activeTopic(state);
  const usage = latestActiveUsage(state);
  const contextUsage = activeContextBreakdown(state);
  const total = topic ? state.topicUsage[topic.id] : undefined;
  const hasTopicUsage = total !== undefined && total.queries > 0;
  const ratio =
    contextUsage?.context !== undefined && contextUsage.contextWindow
      ? Math.round((contextUsage.context / contextUsage.contextWindow) * 100)
      : undefined;
  return [
    line("  Status", { fg: theme.accent, bold: true }),
    line(""),
    line(`  Topic       ${topic?.title ?? "none"}`),
    line(`  Agent       ${topic?.agent ?? "none"}`),
    line(`  Model       ${effectiveTopicModel(topic)}`),
    line(`  Effort      ${topic?.effectiveEffort ?? topic?.defaultEffort ?? "-"}`),
    line(""),
    line(
      `  Context     ${contextUsage?.estimated ? "~" : ""}${tokenCount(contextUsage?.context)} / ${tokenCount(contextUsage?.contextWindow)}${ratio === undefined ? "" : ` (${ratio}%)`}`,
      { fg: contextUsageColor(ratio) },
    ),
    line(
      contextUsage?.estimated
        ? "  Live estimate; replaced by provider usage when the turn finishes"
        : "  Measured on the latest model request",
      { fg: theme.muted, dim: true },
    ),
    line(""),
    line(`  Last turn   input ${tokenCount(usage?.input)} · output ${tokenCount(usage?.output)}`),
    line(`  Cache read  ${tokenCount(usage?.cachedInput)}`),
    line("  Turn input is aggregate spend; it is not context size.", {
      fg: theme.muted,
      dim: true,
    }),
    line(""),
    line("  Topic cumulative", { fg: theme.cyan, bold: true }),
    line(`  Queries     ${hasTopicUsage ? total.queries.toLocaleString() : "unavailable"}`),
    line(
      `  Input       ${hasTopicUsage ? tokenCount(total.inputTokens) : "unavailable"} cache miss`,
    ),
    line(`  Output      ${hasTopicUsage ? tokenCount(total.outputTokens) : "unavailable"}`),
    line(
      `  Cache write ${hasTopicUsage ? tokenCount(total.cacheCreationInputTokens) : "unavailable"}`,
    ),
    line(`  Cache read  ${hasTopicUsage ? tokenCount(total.cacheReadInputTokens) : "unavailable"}`),
    line(
      `  Est. cost   ${hasTopicUsage ? `$${total.estimatedCostUsd.toFixed(4)}` : "unavailable"}`,
    ),
    line(""),
    line("  Esc close", { fg: theme.muted }),
  ];
}

function contextLines(state: AppState): UiLine[] {
  const usage = activeContextBreakdown(state);
  const ratio = usage ? Math.round((usage.context / usage.contextWindow) * 100) : undefined;
  const value = (tokens: number | undefined) => tokenCount(tokens);
  return [
    line("  Context", { fg: theme.accent, bold: true }),
    line(""),
    line(
      `  ${usage?.estimated ? "Estimated" : "Current"}    ${usage?.estimated ? "~" : ""}${value(usage?.context)} / ${value(usage?.contextWindow)}${ratio === undefined ? "" : ` (${ratio}%)`}`,
      { fg: contextUsageColor(ratio) },
    ),
    line(""),
    line("  Breakdown", { fg: theme.cyan, bold: true }),
    line(`  Confirmed    ${value(usage?.confirmed)}`),
    line(`  New user     ${value(usage?.user)}`),
    line(`  Assistant    ${value(usage?.assistant)}`),
    line(`  Tools        ${value(usage?.tools)}`),
    line(`  Free         ${value(usage?.free)}`),
    line(""),
    line(
      usage?.estimated
        ? "  Live estimate; final provider usage replaces it"
        : "  Provider-confirmed latest request; live categories appear during a turn",
      { fg: theme.muted, dim: true },
    ),
    line("  System prompt and tool schemas are included in Confirmed", {
      fg: theme.muted,
      dim: true,
    }),
    line(""),
    line("  Esc close", { fg: theme.muted }),
  ];
}

type TopicOverlayEntry =
  | { kind: "heading"; label: string }
  | { kind: "separator" }
  | { kind: "topic"; topic: TopicDto; topicIndex: number }
  | {
      kind: "background";
      sessionId: string;
      label: string;
      status: string;
      active: boolean;
    };

function subagentTreePrefix(topic: TopicDto, topics: TopicDto[], rootTopicId?: string): string {
  if (!topic.isSubagent || topic.id === rootTopicId) return "";
  const byId = new Map(topics.map((candidate) => [candidate.id, candidate]));
  const childrenByParent = new Map<string, TopicDto[]>();
  for (const candidate of topics) {
    if (!candidate.isSubagent || !candidate.parentTopicId) continue;
    const children = childrenByParent.get(candidate.parentTopicId) ?? [];
    children.push(candidate);
    childrenByParent.set(candidate.parentTopicId, children);
  }

  const lineage = [topic];
  const visited = new Set([topic.id]);
  let current = topic;
  while (current.isSubagent && current.id !== rootTopicId) {
    if (!current.parentTopicId) return "?─ ";
    const parent = byId.get(current.parentTopicId);
    if (!parent || visited.has(parent.id)) return "?─ ";
    visited.add(parent.id);
    lineage.unshift(parent);
    current = parent;
  }

  let prefix = "";
  for (let index = 1; index < lineage.length; index += 1) {
    const node = lineage[index];
    const parent = lineage[index - 1];
    const siblings = childrenByParent.get(parent.id) ?? [];
    const isLast = siblings.at(-1)?.id === node.id;
    prefix += index === lineage.length - 1 ? (isLast ? "└─ " : "├─ ") : isLast ? "   " : "│  ";
  }
  return prefix;
}

/**
 * Picker key hints, longest first for `pickFitting`.
 *
 * The overlay body is hard-clipped to the terminal width by `renderBody`, so an
 * overlong hint would silently lose its tail — dropping to a shorter phrasing
 * keeps the highest-value keys visible instead. Order of importance: navigate,
 * filter, create, then the destructive/stateful chords.
 */
function topicPickerHints(topicPickerRoot: boolean): string[] {
  const exit = topicPickerRoot ? "Esc/Ctrl-C exit" : "Esc close · Ctrl-C exit; work continues";
  const shortExit = topicPickerRoot ? "Esc/Ctrl-C exit" : "Esc close";
  // `pickFitting` takes the first candidate that fits, so a shorter entry
  // placed ahead of a longer one makes the longer one unreachable at every
  // width. Hand-ordering this list is fragile — `exit` and `shortExit` are the
  // same string in root mode, so the same literals collapse to different
  // lengths depending on the caller — so sort by rendered width instead of
  // trusting the source order, and drop the duplicates the collapse creates.
  const candidates = [
    `↑↓ select · Enter open · type to filter · Ctrl-N new · Ctrl-D delete · ${exit}`,
    `↑↓ select · Enter open · type to filter · Ctrl-N new · Ctrl-D delete · ${shortExit}`,
    `↑↓ select · Enter open · type to filter · Ctrl-N new · Ctrl-D delete · ${exit}`,
    `↑↓ select · Enter open · type to filter · Ctrl-N/D · ${shortExit}`,
    "↑↓ · Enter · type to filter · Ctrl-N/D",
    "type to filter · Ctrl-N/D",
    "Ctrl-N/D",
  ];
  return [...new Set(candidates)].sort((a, b) => displayWidth(b) - displayWidth(a));
}

/**
 * Where the filter row sits inside {@link topicOverlayLines} (0-based), and the
 * text before the query on it. Both are needed by {@link topicOverlayCursor} to
 * place the hardware cursor; keeping them as shared constants is what stops the
 * caret and the drawn row from drifting apart.
 */
const TOPIC_FILTER_ROW_INDEX = 2;
const TOPIC_FILTER_LABEL = "  Filter: ";

/**
 * Explicit caret for the topic filter.
 *
 * The composer is hidden while the picker is open, so without this the frame
 * reported no cursor at all and the terminal left it wherever the last frame
 * put it. A Hangul IME anchors its preedit to the hardware cursor, so composing
 * a Korean topic name showed the in-progress syllable in the wrong place.
 *
 * Returned for an *empty* query too, parked where the first character will be
 * drawn. Preedit starts before anything is committed — the moment the user
 * presses the first jamo is exactly the moment the query is still empty — so
 * skipping the caret here would leave the very first syllable of a Korean
 * search floating at the previous frame's cursor. The filter row is blank at
 * that point, but the caret sits at the column the text is about to occupy, so
 * committing the character advances it by one cell instead of jumping.
 *
 * Clipped to the pane width, matching `fit()` truncation of the row, so it can
 * never be pushed outside the frame on a narrow terminal.
 */
function topicOverlayCursor(
  state: AppState,
  width: number,
  bodyHeight: number,
): { x: number; y: number } | null {
  if (state.overlay !== "topics") return null;
  const y = TOPIC_FILTER_ROW_INDEX + 1;
  if (y > bodyHeight) return null;
  const drawn = `${TOPIC_FILTER_LABEL}${safeText(state.topicFilter.trim())}`;
  return { x: Math.max(1, Math.min(displayWidth(drawn) + 1, width)), y };
}

function topicOverlayLines(
  state: AppState,
  width: number,
  height: number,
  animationFrame = 0,
): UiLine[] {
  const visibleIds = visibleTopicPickerIds(state);
  const indexedTopics = state.topics
    .map((topic, topicIndex) => ({ topic, topicIndex }))
    .filter(({ topic }) => visibleIds.has(topic.id));
  const managerTopics = indexedTopics.filter(({ topic }) => topic.kind === "manager");
  const regularTopics = indexedTopics.filter(({ topic }) => topic.kind !== "manager");
  const entries: TopicOverlayEntry[] = [];
  for (const [label, topics] of [
    ["Manager", managerTopics],
    ["Topics", regularTopics],
  ] as const) {
    if (topics.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: "separator" });
    entries.push({ kind: "heading", label });
    entries.push(
      ...topics.map(({ topic, topicIndex }) => ({
        kind: "topic" as const,
        topic,
        topicIndex,
      })),
    );
  }
  const matchingSessions = visibleBackgroundSessions(state);
  for (const kind of ["cron", "memory", "compact"] as const) {
    const sessions = matchingSessions.filter((session) => session.kind === kind);
    if (sessions.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: "separator" });
    entries.push({
      kind: "heading",
      label: kind === "memory" ? "Memory" : kind === "compact" ? "Compact" : "Cron",
    });
    entries.push(
      ...sessions.map((session) => ({
        kind: "background" as const,
        sessionId: session.id,
        label: session.title,
        status: session.status,
        active: session.active ?? true,
      })),
    );
  }
  const visibleCount = Math.max(1, height - 3);
  const selectedEntryIndex = entries.findIndex(
    (entry) =>
      (entry.kind === "topic" &&
        !state.topicPickerBackgroundId &&
        entry.topicIndex === state.topicPickerIndex) ||
      (entry.kind === "background" && entry.sessionId === state.topicPickerBackgroundId),
  );
  const start = Math.min(
    Math.max(0, entries.length - visibleCount),
    Math.max(0, selectedEntryIndex - visibleCount + 1),
  );
  const query = state.topicFilter.trim();
  return [
    line("  Topics", { fg: theme.accent, bold: true }),
    line(`  ${pickFitting(topicPickerHints(state.topicPickerRoot), Math.max(0, width - 2))}`, {
      fg: theme.muted,
    }),
    // The filter reuses the blank spacer row instead of adding a fourth header
    // line, so turning filtering on never steals a row from the list itself and
    // `visibleCount` below stays valid unchanged.
    query.length > 0
      ? line(`${TOPIC_FILTER_LABEL}${safeText(query)}`, { fg: theme.cyan, bold: true })
      : line(""),
    ...(entries.length === 0
      ? [
          line(
            query.length > 0
              ? `  No topics match “${safeText(query)}” · Esc clears the filter`
              : "  No topics yet · Press Ctrl-N to create one",
            { fg: theme.muted },
          ),
        ]
      : entries.slice(start, start + visibleCount).map((entry) => {
          if (entry.kind === "heading") {
            return line(`  ${entry.label}`, { fg: theme.cyan, bold: true });
          }
          if (entry.kind === "separator") {
            return line(`  ${"─".repeat(Math.max(1, width - 4))}`, { fg: theme.border });
          }
          if (entry.kind === "background") {
            const selected = entry.sessionId === state.topicPickerBackgroundId;
            return line(
              `  ${selected ? "›" : " "} ${entry.active ? workingFrame(animationFrame) : "○"} ${entry.label}  ·  ${entry.status}`,
              {
                fg: selected ? theme.text : entry.active ? theme.green : theme.muted,
                bg: selected ? theme.selected : theme.canvas,
                bold: selected,
              },
            );
          }
          const { topic, topicIndex } = entry;
          const selected = topicIndex === state.topicPickerIndex;
          const running = state.activity[topic.id]?.running;
          const childPrefix = subagentTreePrefix(topic, state.topics);
          return line(
            `  ${selected ? "›" : " "} ${childPrefix}${running ? workingFrame(animationFrame) : "○"} ${topic.title}  ·  ${topic.agent ?? "no agent"}  ·  ${effectiveTopicModel(topic)}  ·  ${effectiveTopicEffort(topic)}`,
            {
              fg: selected ? theme.text : running ? theme.green : theme.muted,
              bg: selected ? theme.selected : theme.canvas,
              bold: selected,
            },
          );
        })),
  ];
}

function backgroundSessionLines(state: AppState, width: number, nowMs = terminalNowMs()): UiLine[] {
  const session = pickedBackgroundSession(state);
  if (!session) return [line("  This background session has finished.", { fg: theme.muted })];
  const elapsed = formatElapsedDuration(
    Math.max(0, Math.floor((nowMs - Date.parse(session.startedAt)) / 1_000)),
  );
  return [
    line(
      `  ${session.kind === "memory" ? "Memory" : session.kind === "compact" ? "Compact" : "Cron"} · read-only`,
      {
        fg: theme.accent,
        bold: true,
      },
    ),
    line(
      session.kind === "cron"
        ? "  Esc back · session stays available between runs"
        : "  Esc back · completed logs remain available for 5 minutes",
      { fg: theme.muted },
    ),
    line(""),
    line(`  ${session.title}`, { bold: true }),
    line(`  ${session.status}${session.active === false ? "" : ` · ${elapsed}`}`, {
      fg: session.active === false ? theme.muted : theme.green,
    }),
    ...(session.agent || session.model || session.effort
      ? [
          line(
            `  ${session.agent ?? "-"} · ${session.model ?? "default"} · ${session.effort ?? "default"}`,
            { fg: theme.muted },
          ),
        ]
      : []),
    ...(session.prompt
      ? [
          line(""),
          line(`  ${session.promptTitle ?? "Prompt"}`, { fg: theme.cyan, bold: true }),
          ...session.prompt
            .split("\n")
            .flatMap((part) => wrapText(part || " ", Math.max(4, width - 4)))
            .map((part) => line(`  ${safeText(part)}`, { fg: theme.text })),
        ]
      : []),
    line(""),
    line("  Activity", { fg: theme.cyan, bold: true }),
    ...(session.steps.length > 0
      ? session.steps.flatMap((step) =>
          wrapText(step, Math.max(4, width - 6)).map((part, index) =>
            line(`  ${index === 0 ? "○" : " "} ${safeText(part)}`, { fg: theme.muted }),
          ),
        )
      : [line("  ○ Waiting for runtime activity", { fg: theme.muted })]),
    ...(session.output
      ? [
          line(""),
          line("  Output", { fg: theme.cyan, bold: true }),
          ...renderMarkdown(session.output, width),
        ]
      : []),
  ];
}

function backgroundSessionViewportLines(
  state: AppState,
  width: number,
  height: number,
  nowMs: number,
): UiLine[] {
  const all = backgroundSessionLines(state, width, nowMs);
  const { contentHeight, maxOffset, offset } = conversationViewport(
    all.length,
    height,
    state.backgroundScrollOffset,
  );
  const end = all.length - offset;
  const visible = all.slice(Math.max(0, end - contentHeight), end);
  if (offset <= 0) return visible;
  return [
    line(
      offset >= maxOffset
        ? "  ↑ Start of background session"
        : `  ↑ earlier activity · ${offset} lines from latest · wheel down/PgDn to return`,
      { fg: theme.amber, dim: true },
    ),
    ...visible,
  ];
}

function subagentGraphLines(
  state: AppState,
  width: number,
  height: number,
  animationFrame: number,
): UiLine[] {
  const headerHeight = 6;
  const canvas = state.subagentGraph;
  const offset = state.subagentGraphOffset;
  const viewportWidth = Math.max(1, width - 4);
  const viewportHeight = Math.max(1, height - headerHeight);
  const maxX = Math.max(0, (canvas?.width ?? 0) - viewportWidth);
  const maxY = Math.max(0, (canvas?.height ?? 0) - viewportHeight);
  const x = Math.min(maxX, offset.x);
  const y = Math.min(maxY, offset.y);
  const position = maxX > 0 || maxY > 0 ? ` · view ${x + 1},${y + 1}/${maxX + 1},${maxY + 1}` : "";
  const graphNodes = canvas?.nodes ?? [];
  const graphEdges = canvas?.edges ?? [];
  const runningNodes = graphNodes.filter((node) => state.activity[node.id]?.running);
  const nodeTitleById = new Map(graphNodes.map((node) => [node.id, node.label]));
  const hasActiveTell = (sourceTopicId: string, targetTopicId: string): boolean => {
    const targetTitle = nodeTitleById.get(targetTopicId);
    const activity = state.activity[sourceTopicId];
    return Boolean(
      activity?.running &&
        activity.tools.some(
          (tool) =>
            tool.sessionAction === "tell" &&
            (tool.sessionTarget === targetTopicId || tool.sessionTarget === targetTitle),
        ),
    );
  };
  const activeEdges = graphEdges.filter(
    (edge) =>
      hasActiveTell(edge.source, edge.target) ||
      ((edge.kind === "owns" || edge.kind === "tell-bidirectional") &&
        hasActiveTell(edge.target, edge.source)),
  );
  const highlightedCellsByRow = new Map<number, Set<number>>();
  for (const edge of activeEdges) {
    for (const cell of edge.cells) {
      const columns = highlightedCellsByRow.get(cell.y) ?? new Set<number>();
      columns.add(cell.x);
      highlightedCellsByRow.set(cell.y, columns);
    }
  }
  const rootTopicId = graphNodes[0]?.id;
  const rootRunning = rootTopicId
    ? Boolean(state.activity[rootTopicId]?.running)
    : Boolean(canvas?.rootRunning);

  const header = [
    line("  Agent graph", {
      fg: theme.accent,
      bold: true,
    }),
    line(
      canvas
        ? `  ${rootRunning ? workingFrame(animationFrame) : "○"} ${canvas.title}${canvas.rootDetail ? ` · ${canvas.rootDetail}` : ""}`
        : "  Current topic",
      { fg: rootRunning ? theme.green : theme.text, bold: true },
    ),
    line(
      runningNodes.length > 0
        ? `  Working: ${runningNodes.map((node) => node.label).join(", ")}`
        : "  Working: none",
      { fg: runningNodes.length > 0 ? theme.green : theme.muted },
    ),
    line(
      `  [/] spacing ${state.subagentGraphSpacing} · drag: all directions · wheel: up/down · arrows/hjkl move · Ctrl-G/Esc close${position}`,
      {
        fg: theme.muted,
      },
    ),
    line("  solid ↕: parent/child mutual · solid ↓: status-only · dotted: tell_session", {
      fg: theme.subtle,
    }),
    line(""),
  ];
  if (state.subagentGraphLoading) {
    return [...header, line("  Laying out graph with Orchgraph…", { fg: theme.cyan })].slice(
      0,
      height,
    );
  }
  if (!canvas || canvas.lines.length === 0) {
    return [...header, line("  No graph data", { fg: theme.muted })].slice(0, height);
  }

  return [
    ...header,
    ...Array.from({ length: viewportHeight }, (_, index) => {
      const canvasY = y + index;
      let canvasLine = canvas.lines[canvasY] ?? "";
      for (const node of graphNodes) {
        if (node.markerY !== canvasY) continue;
        const marker = state.activity[node.id]?.running ? workingFrame(animationFrame) : "○";
        canvasLine = replaceAtDisplayColumn(canvasLine, node.markerX, marker);
      }
      const text = sliceWidthRange(canvasLine, x, viewportWidth);
      const baseColor = /[╭╮╰╯]/.test(text) ? theme.cyan : theme.muted;
      const highlightedColumns = highlightedCellsByRow.get(canvasY);
      return highlightedColumns?.size
        ? line(`  ${text}`, {
            fg: baseColor,
            spans: graphLineSpans(canvasLine, x, viewportWidth, highlightedColumns, baseColor),
          })
        : line(`  ${text}`, { fg: baseColor });
    }),
  ].slice(0, height);
}

function decisionGraphLines(state: AppState, width: number, height: number): UiLine[] {
  const headerHeight = 5;
  const canvas = state.decisionGraph;
  const offset = state.decisionGraphOffset;
  const viewportWidth = Math.max(1, width - 4);
  const viewportHeight = Math.max(1, height - headerHeight);
  const maxX = Math.max(0, (canvas?.width ?? 0) - viewportWidth);
  const maxY = Math.max(0, (canvas?.height ?? 0) - viewportHeight);
  const x = Math.min(maxX, offset.x);
  const y = Math.min(maxY, offset.y);
  const position = maxX > 0 || maxY > 0 ? ` · view ${x + 1},${y + 1}/${maxX + 1},${maxY + 1}` : "";
  const header = [
    line("  Decision graph", { fg: theme.accent, bold: true }),
    line(`  ${canvas?.title ?? activeTopic(state)?.title ?? "Current topic"}`, {
      fg: theme.text,
      bold: true,
    }),
    line(
      `  [/] spacing ${state.decisionGraphSpacing} · drag/wheel/arrows/hjkl move · Ctrl-D/Esc close${position}`,
      { fg: theme.muted },
    ),
    line("  ○ accepted · ◷ proposed · ✓ executed · ✗ rejected · ! superseded", {
      fg: theme.subtle,
    }),
    line(""),
  ];
  if (state.decisionGraphLoading) {
    return [...header, line("  Laying out decisions with Orchgraph…", { fg: theme.cyan })].slice(
      0,
      height,
    );
  }
  if (!canvas || canvas.lines.length === 0) {
    return [...header, line("  No decision graph data", { fg: theme.muted })].slice(0, height);
  }
  return [
    ...header,
    ...Array.from({ length: viewportHeight }, (_, index) => {
      const text = sliceWidthRange(canvas.lines[y + index] ?? "", x, viewportWidth);
      return line(`  ${text}`, { fg: /[╭╮╰╯]/.test(text) ? theme.cyan : theme.muted });
    }),
  ].slice(0, height);
}

function modelOverlayLines(state: AppState, height: number): UiLine[] {
  const currentModel = effectiveTopicModel(activeTopic(state));
  const modelColumnWidth = Math.max(
    ...SELECTABLE_MODELS.map(({ model }) => `${model} (current)`.length),
  );
  const visibleCount = Math.max(1, height - 3);
  const start = Math.min(
    Math.max(0, SELECTABLE_MODELS.length - visibleCount),
    Math.max(0, state.modelPickerIndex - visibleCount + 1),
  );
  return [
    line("  Models", { fg: theme.accent, bold: true }),
    line("  ↑↓ select · Enter apply · Esc close", { fg: theme.muted }),
    line(""),
    ...SELECTABLE_MODELS.slice(start, start + visibleCount).map(
      ({ model, description }, visibleIndex) => {
        const index = start + visibleIndex;
        const selected = index === state.modelPickerIndex;
        const current = model === currentModel;
        const label = `${model}${current ? " (current)" : ""}`.padEnd(modelColumnWidth);
        return line(`  ${selected ? "›" : " "} ${label}  ${description}`, {
          fg: selected ? theme.text : current ? theme.green : theme.muted,
          bg: selected ? theme.selected : theme.canvas,
          bold: selected,
        });
      },
    ),
  ];
}

function vaultOverlayLines(state: AppState, width: number, height: number): UiLine[] {
  const header = [
    line("  Vault", { fg: theme.accent, bold: true }),
    line("  Encrypted locally · secret values are never displayed", { fg: theme.muted }),
    line(""),
  ];

  if (state.vaultMode === "confirm-delete") {
    const selected = state.vaultEntries[state.vaultPickerIndex];
    return [
      ...header,
      line(`  Delete ${selected?.key ?? "this key"}?`, { fg: theme.red, bold: true }),
      line(""),
      line("  This cannot be undone. The secret value will be removed.", { fg: theme.muted }),
      line("  Press y to delete or n to cancel.", { fg: theme.amber }),
    ].slice(0, height);
  }

  if (state.vaultMode !== "list") {
    const step = state.vaultMode === "key" ? 1 : state.vaultMode === "value" ? 2 : 3;
    const action = state.vaultEditing ? "Update secret" : "Add secret";
    const guidance =
      state.vaultMode === "key"
        ? "Choose a recognizable key, for example GITHUB_TOKEN."
        : state.vaultMode === "value"
          ? "Enter the secret value. Input is hidden and is never saved to history."
          : "Add an optional description so the agent knows when to use this key.";
    return [
      ...header,
      line(`  ${action} · ${step}/3`, { bold: true }),
      ...(state.vaultDraftKey ? [line(`  Key  ${state.vaultDraftKey}`, { fg: theme.muted })] : []),
      line(""),
      ...wrapText(guidance, Math.max(4, width - 4)).map((text) => line(`  ${text}`)),
      ...(state.vaultNotice
        ? [line(""), line(`  ! ${state.vaultNotice}`, { fg: theme.amber })]
        : []),
    ].slice(0, height);
  }

  const entries = state.vaultEntries;
  const visibleCount = Math.max(1, height - 13);
  return [
    ...header,
    ...(entries.length === 0
      ? [
          line("  No secrets stored", { bold: true }),
          line("  Add one with the command below.", { fg: theme.muted }),
        ]
      : entries.slice(0, visibleCount).map((entry) =>
          line(`  • ${entry.key}  ${entry.description || "No description"}`, {
            fg: theme.muted,
          }),
        )),
    line(""),
    line("  Add or update", { fg: theme.cyan, bold: true }),
    line("  /vault set KEY VALUE | optional description", { fg: theme.text }),
    line("  Example: /vault set GITHUB_TOKEN your-secret-value | GitHub access", {
      fg: theme.muted,
    }),
    line("  Delete", { fg: theme.cyan, bold: true }),
    line("  /vault del KEY", { fg: theme.text }),
    line("  Example: /vault del GITHUB_TOKEN", { fg: theme.muted }),
    line("  Vault commands are never saved to input history.", { fg: theme.muted }),
    ...(state.vaultNotice ? [line(""), line(`  ${state.vaultNotice}`, { fg: theme.green })] : []),
  ].slice(0, height);
}

function effortOverlayLines(state: AppState): UiLine[] {
  const topic = activeTopic(state);
  const currentEffort = topic?.effectiveEffort ?? topic?.defaultEffort;
  const efforts = topic?.agent ? getRegistry(topic.agent).validEfforts : EFFORT_VALUES;
  return [
    line("  Reasoning effort", { fg: theme.accent, bold: true }),
    line("  ↑↓ select · Enter apply · Esc close", { fg: theme.muted }),
    line(""),
    ...efforts.map((effort, index) => {
      const selected = index === state.effortPickerIndex;
      const current = effort === currentEffort;
      return line(`  ${selected ? "›" : " "} ${effort}${current ? " (current)" : ""}`, {
        fg: selected ? theme.text : current ? theme.green : theme.muted,
        bg: selected ? theme.selected : theme.canvas,
        bold: selected,
      });
    }),
  ];
}

function conversationContentLines(
  state: AppState,
  width: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
  includeTasks = true,
): UiLine[] {
  const all: UiLine[] = [];
  for (const message of activeMessages(state).filter(
    (item) =>
      !item.id.startsWith("tasks-") &&
      item.kind !== "system" &&
      (item.authorId !== "system" || isVisibleSystemMessage(item)),
  )) {
    all.push(...messageLines(message, width, state.userId));
  }
  all.push(...activityLines(state, animationFrame, nowMs));
  if (includeTasks) all.push(...taskLines(state, width));
  if (all.length === 0) {
    all.push(
      line(""),
      line("  ✦ Start a conversation", { fg: theme.accent, bold: true }),
      line("  Ask, build, research, or delegate from the composer below.", { fg: theme.muted }),
    );
  }
  return all;
}

function conversationLines(
  state: AppState,
  width: number,
  height: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
  includeTasks = true,
): UiLine[] {
  if (state.overlay === "help") return helpLines().slice(0, height);
  if (state.overlay === "status") return statusLines(state).slice(0, height);
  if (state.overlay === "context") return contextLines(state).slice(0, height);
  if (state.overlay === "topics")
    return topicOverlayLines(state, width, height, animationFrame).slice(0, height);
  if (state.overlay === "subagents")
    return subagentGraphLines(state, width, height, animationFrame);
  if (state.overlay === "decisions") return decisionGraphLines(state, width, height);
  if (state.overlay === "background-session")
    return backgroundSessionViewportLines(state, width, height, nowMs);
  if (state.overlay === "models") return modelOverlayLines(state, height).slice(0, height);
  if (state.overlay === "effort") return effortOverlayLines(state).slice(0, height);
  if (state.overlay === "vault") return vaultOverlayLines(state, width, height);
  if (state.creatingTopic) {
    return [
      line(""),
      line("  New topic", { fg: theme.accent, bold: true }),
      line(""),
      line("  Type only the topic name in the composer below."),
      line("  Enter create · Esc cancel", { fg: theme.muted }),
    ].slice(0, height);
  }
  if (state.overlay === "confirm-delete") {
    const topic = state.topics.find((candidate) => candidate.id === state.pendingDeleteTopicId);
    return [
      line(""),
      line(`  Delete “${topic?.title ?? "this topic"}”?`, { fg: theme.red, bold: true }),
      line(""),
      line("  The transcript is archived before the topic and its runtime state are removed."),
      line("  Press y to delete or n to cancel.", { fg: theme.amber }),
    ].slice(0, height);
  }

  const all = conversationContentLines(state, width, animationFrame, nowMs, includeTasks);
  const { contentHeight, maxOffset, offset } = conversationViewport(
    all.length,
    height,
    state.scrollOffset,
  );
  const end = all.length - offset;
  const visible = all.slice(Math.max(0, end - contentHeight), end);
  const history = state.activeTopicId ? state.messageHistory[state.activeTopicId] : undefined;
  const marker =
    offset >= maxOffset && history?.loading
      ? "  ↑ Loading older messages…"
      : offset >= maxOffset && history?.hasMore
        ? "  ↑ Loaded history start · Ctrl-E load older"
        : offset >= maxOffset
          ? "  ↑ Start of conversation"
          : `  ↑ history · ${offset} lines from latest · wheel down/PgDn to return`;
  return offset > 0
    ? [
        line(marker, {
          fg: theme.amber,
          dim: true,
        }),
        ...visible,
      ]
    : visible;
}

function conversationViewport(
  lineCount: number,
  height: number,
  requestedOffset: number,
): { contentHeight: number; maxOffset: number; offset: number } {
  if (lineCount <= height) return { contentHeight: height, maxOffset: 0, offset: 0 };
  const contentHeight = Math.max(1, height - 1);
  const maxOffset = Math.max(0, lineCount - contentHeight);
  return {
    contentHeight,
    maxOffset,
    offset: Math.min(maxOffset, Math.max(0, requestedOffset)),
  };
}

function decisionPane(state: AppState, width: number): string[] {
  if (state.overlay) return [];
  const ask = activeQuestion(state);
  const question = ask?.askUserQuestion;
  if (!ask || !question?.choices.length) return [];
  const selected = Math.min(state.askChoiceIndex, question.choices.length - 1);
  const content: UiLine[] = [
    line(`  ${question.question}`, { bold: true }),
    ...question.choices.map((choice, index) =>
      line(
        `  ${index === selected ? "●" : "○"} ${choice.label}${choice.description ? ` — ${choice.description}` : ""}`,
        {
          fg: index === selected ? theme.text : theme.muted,
          bg: index === selected ? theme.selected : theme.surface,
          bold: index === selected,
        },
      ),
    ),
  ];
  return framePane(
    "decision required · ↑↓ select · Enter confirm",
    content,
    width,
    Math.min(8, Math.max(4, content.length + 2)),
    { active: true, accent: theme.amber },
  );
}

interface InputVisual {
  lines: UiLine[];
  cursorLine: number;
  cursorColumn: number;
}

/**
 * Rows *and* cursor for one logical composer line, derived from a single
 * `wrapSegments` call.
 *
 * The two used to be independent walks over the text, which was safe only while
 * `wrapText` folded on raw width. Now that folding depends on word boundaries,
 * any divergence would put the hardware cursor — and with it the Hangul IME
 * preedit anchor — on the wrong cell, so the fold decision is made once and
 * both outputs are read off the same segment list.
 *
 * Exported so the cursor-consistency suite can exercise the exact function the
 * composer uses, rather than a re-implementation of it.
 */
export function wrapLineWithCursor(
  value: string,
  codePointColumn: number,
  width: number,
): { rows: string[]; line: number; column: number } {
  const chars = Array.from(safeText(value));
  if (width < WRAP_MIN_WIDTH) {
    // Below the fold minimum the whole line is clipped to one row, but the
    // caret still has to follow the caret *offset*: measuring the clipped whole
    // string put the cursor after the character at width 1, so "before `a`" and
    // "after `a`" landed on the same cell and typing looked like it went
    // nowhere. Clip the prefix in front of the caret instead.
    const clipped = sliceWidth(value, Math.max(0, width));
    const offset = Math.max(0, Math.min(chars.length, codePointColumn));
    const prefix = sliceWidth(chars.slice(0, offset).join(""), Math.max(0, width));
    return {
      rows: [clipped],
      line: 0,
      column: Math.min(displayWidth(prefix), Math.max(0, width)),
    };
  }
  const segments = wrapSegments(chars, width);
  const offset = Math.max(0, Math.min(chars.length, codePointColumn));
  const rows = segments.map((segment) => chars.slice(segment.start, segment.textEnd).join(""));
  let line = segments.length - 1;
  for (const [index, segment] of segments.entries()) {
    // Strictly `<` so an offset sitting exactly on a fold resolves to the start
    // of the *following* row — which is where the next typed character lands.
    if (offset < segment.end) {
      line = index;
      break;
    }
  }
  const segment = segments[line] ?? { start: 0, end: 0, textEnd: 0 };
  let column = 0;
  for (let index = segment.start; index < offset; index += 1) {
    column += runeWidth(chars[index] ?? "");
  }
  // Only reachable inside an absorbed whitespace run, whose columns are clipped
  // away; park the cursor on the row's last cell rather than off the edge.
  return { rows, line, column: Math.min(column, width) };
}

/** Columns reserved by the composer's "  › " speaker gutter plus its right margin. */
const COMPOSER_GUTTER = 4;
const COMPOSER_RIGHT_MARGIN = 1;
/** Fewer usable columns than this and the gutter is dropped rather than the text. */
const COMPOSER_MIN_CONTENT_WIDTH = 4;

function inputVisualLines(state: AppState, width: number): InputVisual {
  // Continuous, not a breakpoint: the gutter is spent only while it leaves a
  // usable content width behind it (codex `usable_content_width`).
  const gutted = usableContentWidth(
    width,
    COMPOSER_GUTTER + COMPOSER_RIGHT_MARGIN,
    COMPOSER_MIN_CONTENT_WIDTH,
  );
  const gutter = gutted === null ? 0 : COMPOSER_GUTTER;
  const leadPrefix = gutter ? "  › " : "";
  const contPrefix = " ".repeat(gutter);
  const secretInput = state.overlay === "vault" && state.vaultMode === "value";
  const displayInput = secretInput
    ? state.input
        .split("\n")
        .map((row) => "*".repeat(Array.from(row).length))
        .join("\n")
    : state.input;
  if (!displayInput) {
    const placeholder =
      state.overlay === "vault"
        ? state.vaultMode === "list"
          ? "Type /vault set … or /vault del …"
          : state.vaultMode === "key"
            ? "Type a key name…"
            : state.vaultMode === "value"
              ? "Type the secret value…"
              : "Optional description…"
        : state.creatingTopic
          ? "Type a topic name…"
          : "Type a message or /command…";
    return {
      lines: [
        line(`${leadPrefix}${gutter ? "  " : ""}${placeholder}`, {
          fg: theme.subtle,
          bg: theme.surfaceRaised,
        }),
      ],
      cursorLine: 0,
      cursorColumn: gutter + 1,
    };
  }
  const contentWidth = gutted ?? Math.max(1, width - COMPOSER_RIGHT_MARGIN);
  const result: UiLine[] = [];
  let cursorLine = 0;
  let cursorColumn = gutter + 1;
  for (const [row, inputLine] of displayInput.split("\n").entries()) {
    const firstVisualLine = result.length;
    // One wrap per logical line feeds both the rows and the cursor, so the
    // composer can never draw a fold the cursor mapper disagrees with.
    const wrapped = wrapLineWithCursor(inputLine, state.inputCursor.col, contentWidth);
    if (row === state.inputCursor.row) {
      cursorLine = firstVisualLine + wrapped.line;
      cursorColumn = gutter + 1 + wrapped.column;
    }
    for (const [visualIndex, text] of wrapped.rows.entries()) {
      result.push(
        line(`${row === 0 && visualIndex === 0 ? leadPrefix : contPrefix}${text}`, {
          bg: theme.surfaceRaised,
        }),
      );
    }
  }
  return { lines: result, cursorLine, cursorColumn };
}

interface ComposerPane {
  lines: string[];
  cursor: { x: number; y: number };
}

function composerPane(state: AppState, width: number): ComposerPane {
  const title = state.creatingTopic
    ? "new topic · type a name · Enter create"
    : state.overlay === "vault"
      ? state.vaultMode === "list"
        ? "Vault command · Enter run · Esc close"
        : `${state.vaultMode === "key" ? "key" : state.vaultMode === "value" ? "secret value" : "description"} · Enter continue · Esc cancel`
      : "Ctrl-O topics · Ctrl-G subagents · Ctrl-D decisions";
  const visual = inputVisualLines(state, width);
  let inputStart = Math.max(0, visual.lines.length - 5);
  if (visual.cursorLine < inputStart) inputStart = visual.cursorLine;
  else if (visual.cursorLine >= inputStart + 5) inputStart = visual.cursorLine - 4;
  const inputLines = visual.lines.slice(inputStart, inputStart + 5);
  const visibleCursorLine = visual.cursorLine - inputStart;
  const suggestionsDisabled = state.creatingTopic || state.overlay === "vault";
  const commands = suggestionsDisabled ? [] : commandSuggestions(state.input);
  const cap = Math.max(0, 6 - inputLines.length);
  let suggestionLines: ReturnType<typeof line>[];
  if (commands.length > 0) {
    const selectedIndex = Math.min(state.suggestionIndex, commands.length - 1);
    const start = Math.min(
      Math.max(0, selectedIndex - cap + 1),
      Math.max(0, commands.length - cap),
    );
    suggestionLines = commands.slice(start, start + cap).map((command, index) =>
      line(
        `    ${start + index === selectedIndex ? "›" : " "} ${command.usage}  ${command.description}`,
        {
          fg: start + index === selectedIndex ? theme.text : theme.muted,
          bg: start + index === selectedIndex ? theme.selected : theme.surface,
        },
      ),
    );
  } else if (!suggestionsDisabled) {
    // `@`-path completion: suggestions drawn from the real filesystem.
    const cursor = state.inputCursor;
    const lineText = state.input.split("\n")[cursor.row] ?? "";
    const paths = pathSuggestions(lineText, cursor.col);
    const items = paths?.items ?? [];
    const selectedIndex = Math.min(state.suggestionIndex, Math.max(0, items.length - 1));
    const start = Math.min(Math.max(0, selectedIndex - cap + 1), Math.max(0, items.length - cap));
    suggestionLines = items.slice(start, start + cap).map((item, index) => {
      const selected = start + index === selectedIndex;
      return line(`    ${selected ? "›" : " "} ${item.value.slice(1)}`, {
        fg: selected ? theme.text : theme.muted,
        bg: selected ? theme.selected : theme.surface,
      });
    });
    const hidden = (paths?.truncated ?? 0) + Math.max(0, items.length - suggestionLines.length);
    if (hidden > 0 && suggestionLines.length < cap) {
      suggestionLines.push(line(`      … +${hidden} more`, { fg: theme.muted, dim: true }));
    } else if (paths?.searching && suggestionLines.length < cap) {
      suggestionLines.push(line("      searching subfolders...", { fg: theme.muted, dim: true }));
    }
  } else {
    suggestionLines = [];
  }
  const content = [line(""), ...inputLines, line(""), ...suggestionLines].slice(0, 8);
  const input = content.map((item) =>
    paint(fit(item.text, width), {
      fg: item.fg ?? theme.text,
      bg: item.bg ?? theme.surfaceRaised,
      bold: item.bold,
      dim: item.dim,
    }),
  );
  const hint = paint(fit(`  ${title}`, width), { fg: theme.muted, bg: theme.canvas });
  return {
    lines: state.creatingTopic ? [hint, ...input] : [...input, hint],
    cursor: {
      x: visual.cursorColumn,
      y: 2 + visibleCursorLine + (state.creatingTopic ? 1 : 0),
    },
  };
}

/**
 * Priority-ordered fallbacks for the footer's status row and hint row.
 *
 * There is no global "narrow terminal" mode here. Following codex's
 * `bottom_pane/footer.rs`, each row declares its content richest-first and the
 * widest variant that actually measures small enough wins; when even the last
 * one overflows, `joinSides` truncates it. That keeps the degradation
 * continuous instead of snapping at one magic column count.
 */
function footerStatusText(state: AppState): string[] {
  const topic = activeTopic(state);
  const title = `  ${topic?.title ?? "no topic"}`;
  const agent = topic?.agent ?? "-";
  return [
    `${title} · ${agent} · ${effectiveTopicModel(topic)} · ${effectiveTopicEffort(topic)}`,
    `${title} · ${agent} · ${effectiveTopicModel(topic)}`,
    `${title} · ${agent}`,
    title,
  ];
}

interface FooterVariant {
  text: string;
  spans: UiSpan[];
}

function footerUsageText(state: AppState): FooterVariant[] {
  const topic = activeTopic(state);
  if (!topic) return [{ text: "", spans: [] }];
  const contextUsage = activeContextBreakdown(state);
  const total = state.topicUsage[topic.id];
  const ratio =
    contextUsage?.context !== undefined && contextUsage.contextWindow
      ? Math.round((contextUsage.context / contextUsage.contextWindow) * 100)
      : undefined;
  const context =
    contextUsage?.context !== undefined && contextUsage.contextWindow
      ? `${contextUsage.estimated ? "~" : ""}${tokenCount(contextUsage.context)}/${tokenCount(contextUsage.contextWindow)} ${ratio}%`
      : "";
  const hasTopicUsage = total !== undefined && total.queries > 0;
  const cumulative = hasTopicUsage
    ? `Σ ${tokenCount(total.inputTokens)} in/${tokenCount(total.outputTokens)} out`
    : "";
  const cache =
    hasTopicUsage && total.cacheReadInputTokens
      ? `cache ${tokenCount(total.cacheReadInputTokens)}`
      : "";
  const cost = hasTopicUsage ? `est $${total.estimatedCostUsd.toFixed(2)}` : "";
  const variant = (values: readonly { text: string; fg: Rgb }[]): FooterVariant => {
    const present = values.filter((value) => value.text);
    const spans = present.flatMap((value, index) => [
      ...(index > 0 ? [{ text: " · ", fg: theme.subtle }] : []),
      { text: value.text, fg: value.fg },
    ]);
    if (spans.length > 0) spans.push({ text: "  ", fg: theme.muted });
    return {
      text: `${present.map((value) => value.text).join(" · ")}${present.length ? "  " : ""}`,
      spans,
    };
  };
  const values = {
    context: { text: context, fg: contextUsageColor(ratio) },
    cumulative: { text: cumulative, fg: theme.muted },
    cache: { text: cache, fg: theme.muted },
    cost: { text: cost, fg: theme.muted },
  };
  return [
    variant([values.context, values.cumulative, values.cache, values.cost]),
    variant([values.context, values.cumulative, values.cache]),
    variant([values.context, values.cumulative]),
    variant([values.context]),
    variant([]),
  ];
}

function footerStatusLine(state: AppState, width: number): UiSpan[] {
  const leftCandidates = footerStatusText(state);
  const rightCandidates = footerUsageText(state);
  for (const right of rightCandidates) {
    for (const left of leftCandidates) {
      const rightWidth = displayWidth(right.text);
      if (displayWidth(left) + (rightWidth ? 1 + rightWidth : 0) <= width) {
        const gap = width - displayWidth(left) - rightWidth;
        return [
          { text: left, fg: theme.accent, bold: true },
          { text: " ".repeat(gap), bg: theme.surfaceRaised },
          ...right.spans,
        ];
      }
    }
  }
  const left = sliceWidth(leftCandidates[leftCandidates.length - 1] ?? "", width);
  return [
    { text: left, fg: theme.accent, bold: true },
    { text: " ".repeat(Math.max(0, width - displayWidth(left))), bg: theme.surfaceRaised },
  ];
}

function paintFooterSpans(spans: readonly UiSpan[]): string {
  return spans
    .map((span) =>
      paint(span.text, {
        fg: span.fg ?? theme.text,
        bg: span.bg ?? theme.surfaceRaised,
        bold: span.bold,
        dim: span.dim,
      }),
    )
    .join("");
}

/**
 * Glyph + colour per notice severity.
 *
 * The glyph carries the severity on its own so the distinction survives
 * `NO_COLOR` / colour-blindness, where the colour column is unavailable.
 * `!`/amber is kept for `warn` so the pre-severity rendering is unchanged for
 * anything that has not been classified yet, and `✓`/`●`/`·` reuse markers the
 * renderer already emits (`toolMessageLines`, the `·` separators everywhere)
 * rather than widening the glyph vocabulary.
 *
 * Every glyph is `runeWidth === 1`; `tests/render.test.ts` asserts that, since
 * a 2-column glyph here would push the footer past the terminal width and
 * desynchronise the line-diff renderer's row coordinates.
 */
const NOTICE_STYLE: Record<NoticeLevel, { glyph: string; fg: Rgb }> = {
  info: { glyph: "·", fg: theme.muted },
  success: { glyph: "✓", fg: theme.green },
  warn: { glyph: "!", fg: theme.amber },
  error: { glyph: "✗", fg: theme.red },
};

function noticeStyle(state: AppState): { glyph: string; fg: Rgb } {
  return NOTICE_STYLE[state.noticeLevel ?? "warn"];
}

function footerHintText(state: AppState): string[] {
  if (state.notice) return [`${noticeStyle(state).glyph} ${state.notice}  `];
  if (state.overlay === "topics") {
    // With a query in flight Escape narrows to "clear the filter", so the
    // footer has to say that instead of promising to close the overlay.
    if (state.topicFilter.trim().length > 0) {
      return ["Esc clears the filter · ↑↓ select · Enter open  ", "Esc clear filter  ", "Esc  "];
    }
    return state.topicPickerRoot
      ? ["Esc/Ctrl-C exit  ", "Esc exit  "]
      : ["Esc close · Ctrl-C exit; work continues  ", "Esc close · Ctrl-C exit  ", "Esc  "];
  }
  if (state.overlay === "background-session") {
    return [
      "wheel/PgUp/PgDn scroll · Esc back · read-only  ",
      "PgUp/PgDn scroll · Esc back  ",
      "Esc back  ",
    ];
  }
  if (state.overlay === "subagents") {
    return ["arrows/hjkl/wheel move · Esc close  ", "arrows move · Esc close  ", "Esc close  "];
  }
  if (state.overlay === "decisions") {
    return [
      "arrows/hjkl/wheel move · Ctrl-D/Esc close  ",
      "arrows move · Esc close  ",
      "Esc close  ",
    ];
  }
  if (state.overlay === "vault") {
    if (state.vaultMode === "list") return ["Enter run · Esc close  ", "Esc close  "];
    if (state.vaultMode === "confirm-delete") return ["Y delete · N cancel  ", "Y/N  "];
    return ["Enter continue · Esc cancel  ", "Esc cancel  "];
  }
  const topic = activeTopic(state);
  if (topic && state.activity[topic.id]?.running) return ["Esc/Ctrl-C stop  ", "Esc stop  "];
  return ["Ctrl-C twice to quit  ", "Ctrl-C ×2 quit  ", "Ctrl-C  "];
}

function footerLines(state: AppState, width: number): string[] {
  if (state.creatingTopic) {
    return [
      paint(joinSides("  New topic", pickFitting(["○ naming  ", ""], width - 12), width), {
        fg: theme.accent,
        bg: theme.surfaceRaised,
        bold: true,
      }),
      paint(joinSides("", pickFitting(["Esc cancel  ", "Esc  "], width), width), {
        fg: theme.muted,
        bg: theme.canvas,
      }),
    ];
  }
  return [
    paintFooterSpans(footerStatusLine(state, width)),
    paint(joinSides("", pickFitting(footerHintText(state), width), width), {
      fg: state.notice ? noticeStyle(state).fg : theme.muted,
      bg: theme.canvas,
    }),
  ];
}

function renderBody(lines: UiLine[], width: number, height: number): string[] {
  return Array.from({ length: height }, (_, index) => {
    const item = lines[index] ?? line("");
    if (item.spans) {
      let remaining = width;
      const rendered = item.spans
        .map((span) => {
          if (remaining <= 0) return "";
          const text = sliceWidth(safeText(span.text).replaceAll("\n", " "), remaining);
          remaining -= displayWidth(text);
          return paint(text, {
            fg: span.fg ?? item.fg ?? theme.text,
            bg: span.bg ?? item.bg ?? theme.canvas,
            bold: span.bold ?? item.bold,
            dim: span.dim ?? item.dim,
          });
        })
        .join("");
      return `${rendered}${paint(" ".repeat(Math.max(0, remaining)), {
        bg: item.bg ?? theme.canvas,
      })}`;
    }
    return paint(fit(item.text, width), {
      fg: item.fg ?? theme.text,
      bg: item.bg ?? theme.canvas,
      bold: item.bold,
      dim: item.dim,
    });
  });
}

export function renderApp(
  state: AppState,
  columns: number,
  rows: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
): string {
  return renderAppFrame(state, columns, rows, animationFrame, nowMs).frame;
}

export function renderAppFrame(
  state: AppState,
  columns: number,
  rows: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
): RenderedTerminalApp {
  // Never emit a line wider than the terminal actually reported. The line-diff
  // renderer addresses physical rows directly (`CSI <row>;1H`), so a single
  // over-wide row auto-wraps and desynchronises every row coordinate below it
  // — including the hardware cursor used to anchor IME preedit.
  const width = Math.max(1, columns);
  const height = Math.max(14, rows);
  const footer = footerLines(state, width);
  const decision = decisionPane(state, width);
  const hideComposer =
    state.overlay === "background-session" ||
    state.overlay === "topics" ||
    state.overlay === "subagents" ||
    state.overlay === "decisions" ||
    (state.overlay === "vault" && state.vaultMode === "confirm-delete");
  const composer = hideComposer ? { lines: [], cursor: null } : composerPane(state, width);
  const bodyHeight = Math.max(3, height - footer.length - decision.length - composer.lines.length);
  const layout = terminalBodyLayout(state, width);
  const conversation = conversationLines(
    state,
    layout.conversationWidth,
    bodyHeight,
    animationFrame,
    nowMs,
    !layout.showTaskSidebar,
  );
  const conversationBody = renderBody(conversation, layout.conversationWidth, bodyHeight);
  const body = layout.showTaskSidebar
    ? (() => {
        const taskPane = framePane(
          "Tasks · Ctrl-T",
          taskSidebarLines(state, layout.taskWidth, Math.max(0, bodyHeight - 2)),
          layout.taskWidth,
          bodyHeight,
          { active: true, accent: theme.taskBorder },
        );
        // `framePane` skips itself below its minimum inner width; the sidebar
        // only exists above TASK_SIDEBAR_MIN_WIDTH so that cannot happen here,
        // but falling back keeps the row width exact if that ever changes.
        if (taskPane.length === 0) return renderBody(conversation, width, bodyHeight);
        const gap = paint(" ".repeat(TASK_SIDEBAR_GAP), { bg: theme.canvas });
        return conversationBody.map((row, index) => `${row}${gap}${taskPane[index] ?? ""}`);
      })()
    : conversationBody;
  const codeCopyTargets = conversation.flatMap((item, index): CodeCopyTarget[] => {
    if (item.codeCopy === undefined || index >= bodyHeight) return [];
    // The whole visible header ("┌─ code · lang  ⧉") is one click target, not
    // just the single marker cell.
    const trimmed = item.text.trimEnd();
    const leading = trimmed.length - trimmed.trimStart().length;
    const xStart = displayWidth(trimmed.slice(0, leading)) + 1;
    const xEnd = Math.min(displayWidth(trimmed), layout.conversationWidth);
    return xEnd >= xStart ? [{ xStart, xEnd, y: index + 1, text: item.codeCopy }] : [];
  });
  const cursorY = composer.cursor
    ? body.length + decision.length + composer.cursor.y
    : Number.POSITIVE_INFINITY;
  // The topic filter is the one input that lives in the body rather than in the
  // composer, so its caret is measured against the body rows directly.
  const overlayCursor = topicOverlayCursor(state, layout.conversationWidth, body.length);
  const cursor =
    composer.cursor && cursorY <= height
      ? { x: Math.min(composer.cursor.x, width), y: cursorY }
      : overlayCursor && overlayCursor.y <= height
        ? overlayCursor
        : null;
  return {
    frame: linkifyUrls(
      [...body, ...decision, ...composer.lines, ...footer].slice(0, height).join("\n"),
    ),
    cursor,
    codeCopyTargets,
  };
}

export function maxConversationScrollOffset(
  state: AppState,
  columns: number,
  rows: number,
): number {
  const width = Math.max(1, columns);
  const height = Math.max(14, rows);
  if (state.overlay === "background-session") {
    const bodyHeight = Math.max(3, height - footerLines(state, width).length);
    return conversationViewport(
      backgroundSessionLines(state, width, terminalNowMs()).length,
      bodyHeight,
      state.backgroundScrollOffset,
    ).maxOffset;
  }
  if (state.overlay) return 0;
  const bodyHeight = Math.max(
    3,
    height -
      footerLines(state, width).length -
      decisionPane(state, width).length -
      composerPane(state, width).lines.length,
  );
  const layout = terminalBodyLayout(state, width);
  const lineCount = conversationContentLines(
    state,
    layout.conversationWidth,
    0,
    terminalNowMs(),
    !layout.showTaskSidebar,
  ).length;
  return conversationViewport(lineCount, bodyHeight, state.scrollOffset).maxOffset;
}

/**
 * Keep the same topmost conversation content visible when live events add or
 * resize lines below a user who has scrolled into history.
 */
export function preserveConversationScrollAnchor(
  previous: AppState,
  next: AppState,
  columns: number,
  rows: number,
): AppState {
  if (
    previous.scrollOffset <= 0 ||
    previous.activeTopicId !== next.activeTopicId ||
    previous.overlay ||
    next.overlay
  ) {
    return next;
  }
  const previousMax = maxConversationScrollOffset(previous, columns, rows);
  const nextMax = maxConversationScrollOffset(next, columns, rows);
  const scrollOffset = Math.min(
    nextMax,
    Math.max(0, previous.scrollOffset + (nextMax - previousMax)),
  );
  return scrollOffset === next.scrollOffset ? next : { ...next, scrollOffset };
}
