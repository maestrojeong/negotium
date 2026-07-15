export interface BufferCursor {
  row: number;
  col: number;
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function codePointLength(value: string): number {
  return codePoints(value).length;
}

function sliceCodePoints(value: string, start?: number, end?: number): string {
  return codePoints(value).slice(start, end).join("");
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function characterClass(character: string): string {
  if (/\s/u.test(character)) return "space";
  if (!/[\p{L}\p{N}\p{M}_]/u.test(character)) return "punctuation";
  if (/\p{Script=Latin}/u.test(character)) return "word:latin";
  if (/\p{Script=Hangul}/u.test(character)) return "word:hangul";
  if (/\p{Script=Han}/u.test(character)) return "word:han";
  if (/\p{Script=Hiragana}/u.test(character)) return "word:hiragana";
  if (/\p{Script=Katakana}/u.test(character)) return "word:katakana";
  if (/\p{Script=Cyrillic}/u.test(character)) return "word:cyrillic";
  if (/\p{Script=Arabic}/u.test(character)) return "word:arabic";
  return "word:other";
}

/**
 * Logical multiline editor buffer. Rows and columns are Unicode code-point
 * positions rather than UTF-16 offsets, so Korean and emoji edit atomically.
 */
export class TextBuffer {
  #lines: string[] = [""];
  #cursor: BufferCursor = { row: 0, col: 0 };
  #preferredCol: number | null = null;

  constructor(initialText = "") {
    this.setText(initialText);
  }

  get text(): string {
    return this.#lines.join("\n");
  }

  get lines(): readonly string[] {
    return this.#lines;
  }

  get cursor(): BufferCursor {
    return { ...this.#cursor };
  }

  get isAtStart(): boolean {
    return this.#cursor.row === 0 && this.#cursor.col === 0;
  }

  get isAtEnd(): boolean {
    const lastRow = this.#lines.length - 1;
    return (
      this.#cursor.row === lastRow && this.#cursor.col === codePointLength(this.#lines[lastRow])
    );
  }

  get isOnFirstLine(): boolean {
    return this.#cursor.row === 0;
  }

  get isOnLastLine(): boolean {
    return this.#cursor.row === this.#lines.length - 1;
  }

  setText(value: string, cursor: "start" | "end" | BufferCursor = "end"): void {
    this.#lines = normalizeText(value).split("\n");
    if (this.#lines.length === 0) this.#lines = [""];
    if (cursor === "start") this.#cursor = { row: 0, col: 0 };
    else if (cursor === "end") {
      const row = this.#lines.length - 1;
      this.#cursor = { row, col: codePointLength(this.#lines[row]) };
    } else {
      this.#cursor = this.#clampCursor(cursor);
    }
    this.#preferredCol = null;
  }

  insert(value: string): void {
    if (!value) return;
    this.#replaceRange(this.#cursor, this.#cursor, normalizeText(value));
  }

  backspace(): boolean {
    if (this.isAtStart) return false;
    const end = this.cursor;
    const start = this.cursor;
    if (start.col > 0) start.col -= 1;
    else {
      start.row -= 1;
      start.col = codePointLength(this.#lines[start.row]);
    }
    this.#replaceRange(start, end, "");
    return true;
  }

  deleteForward(): boolean {
    if (this.isAtEnd) return false;
    const start = this.cursor;
    const end = this.cursor;
    const lineLength = codePointLength(this.#lines[end.row]);
    if (end.col < lineLength) end.col += 1;
    else {
      end.row += 1;
      end.col = 0;
    }
    this.#replaceRange(start, end, "");
    return true;
  }

  deleteWordLeft(): boolean {
    if (this.isAtStart) return false;
    const end = this.cursor;
    this.moveWordLeft();
    this.#replaceRange(this.cursor, end, "");
    return true;
  }

  clearBeforeCursor(): void {
    this.#replaceRange({ row: 0, col: 0 }, this.cursor, "");
  }

  clearAfterCursor(): void {
    const row = this.#lines.length - 1;
    this.#replaceRange(this.cursor, { row, col: codePointLength(this.#lines[row]) }, "");
  }

  moveLeft(): void {
    if (this.#cursor.col > 0) this.#cursor.col -= 1;
    else if (this.#cursor.row > 0) {
      this.#cursor.row -= 1;
      this.#cursor.col = codePointLength(this.#lines[this.#cursor.row]);
    }
    this.#preferredCol = null;
  }

  moveRight(): void {
    const lineLength = codePointLength(this.#lines[this.#cursor.row]);
    if (this.#cursor.col < lineLength) this.#cursor.col += 1;
    else if (this.#cursor.row < this.#lines.length - 1) {
      this.#cursor.row += 1;
      this.#cursor.col = 0;
    }
    this.#preferredCol = null;
  }

  moveUp(): void {
    if (this.#cursor.row === 0) return;
    const preferred = this.#preferredCol ?? this.#cursor.col;
    this.#preferredCol = preferred;
    this.#cursor.row -= 1;
    this.#cursor.col = Math.min(preferred, codePointLength(this.#lines[this.#cursor.row]));
  }

  moveDown(): void {
    if (this.#cursor.row >= this.#lines.length - 1) return;
    const preferred = this.#preferredCol ?? this.#cursor.col;
    this.#preferredCol = preferred;
    this.#cursor.row += 1;
    this.#cursor.col = Math.min(preferred, codePointLength(this.#lines[this.#cursor.row]));
  }

  moveHome(): void {
    this.#cursor.col = 0;
    this.#preferredCol = null;
  }

  moveEnd(): void {
    this.#cursor.col = codePointLength(this.#lines[this.#cursor.row]);
    this.#preferredCol = null;
  }

  moveWordLeft(): void {
    if (this.#cursor.col === 0) {
      if (this.#cursor.row === 0) return;
      this.#cursor.row -= 1;
      this.#cursor.col = codePointLength(this.#lines[this.#cursor.row]);
    }
    const characters = codePoints(this.#lines[this.#cursor.row]);
    let col = this.#cursor.col;
    while (col > 0 && characterClass(characters[col - 1]) === "space") col -= 1;
    if (col > 0) {
      const targetClass = characterClass(characters[col - 1]);
      while (col > 0 && characterClass(characters[col - 1]) === targetClass) col -= 1;
    }
    this.#cursor.col = col;
    this.#preferredCol = null;
  }

  moveWordRight(): void {
    const characters = codePoints(this.#lines[this.#cursor.row]);
    let col = this.#cursor.col;
    if (col >= characters.length) {
      if (this.#cursor.row >= this.#lines.length - 1) return;
      this.#cursor.row += 1;
      this.#cursor.col = 0;
      this.#preferredCol = null;
      return;
    }
    const targetClass = characterClass(characters[col]);
    while (col < characters.length && characterClass(characters[col]) === targetClass) col += 1;
    while (col < characters.length && characterClass(characters[col]) === "space") col += 1;
    this.#cursor.col = col;
    this.#preferredCol = null;
  }

  #clampCursor(cursor: BufferCursor): BufferCursor {
    const row = Math.max(0, Math.min(cursor.row, this.#lines.length - 1));
    return {
      row,
      col: Math.max(0, Math.min(cursor.col, codePointLength(this.#lines[row]))),
    };
  }

  #replaceRange(startInput: BufferCursor, endInput: BufferCursor, replacement: string): void {
    const start = this.#clampCursor(startInput);
    const end = this.#clampCursor(endInput);
    if (start.row > end.row || (start.row === end.row && start.col > end.col)) return;
    const prefix = sliceCodePoints(this.#lines[start.row], 0, start.col);
    const suffix = sliceCodePoints(this.#lines[end.row], end.col);
    const parts = normalizeText(replacement).split("\n");
    if (parts.length === 1) {
      this.#lines.splice(start.row, end.row - start.row + 1, `${prefix}${parts[0]}${suffix}`);
      this.#cursor = { row: start.row, col: start.col + codePointLength(parts[0]) };
    } else {
      const first = `${prefix}${parts[0]}`;
      const lastPart = parts.at(-1) ?? "";
      const last = `${lastPart}${suffix}`;
      this.#lines.splice(start.row, end.row - start.row + 1, first, ...parts.slice(1, -1), last);
      this.#cursor = {
        row: start.row + parts.length - 1,
        col: codePointLength(lastPart),
      };
    }
    this.#preferredCol = null;
  }
}

/** Shell-like history navigation with restoration of the unfinished draft. */
export class InputHistory {
  #entries: string[];
  #index: number;
  #draft = "";

  constructor(
    entries: readonly string[] = [],
    readonly maxEntries = 200,
  ) {
    this.#entries = entries.filter(Boolean).slice(-maxEntries);
    this.#index = this.#entries.length;
  }

  get entries(): readonly string[] {
    return this.#entries;
  }

  record(value: string): void {
    const text = value.trim();
    if (!text) return;
    if (this.#entries.at(-1) !== text) this.#entries.push(text);
    this.#entries = this.#entries.slice(-this.maxEntries);
    this.reset();
  }

  previous(currentDraft: string): string | null {
    if (this.#entries.length === 0 || this.#index === 0) return null;
    if (this.#index === this.#entries.length) this.#draft = currentDraft;
    this.#index -= 1;
    return this.#entries[this.#index] ?? null;
  }

  next(): string | null {
    if (this.#index >= this.#entries.length) return null;
    this.#index += 1;
    return this.#index === this.#entries.length ? this.#draft : (this.#entries[this.#index] ?? "");
  }

  reset(): void {
    this.#index = this.#entries.length;
    this.#draft = "";
  }
}
