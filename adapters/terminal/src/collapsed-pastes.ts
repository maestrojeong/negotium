export const COLLAPSED_PASTE_MIN_CHARS = 500;
export const COLLAPSED_PASTE_MIN_LINES = 8;

interface CollapsedPaste {
  label: string;
  original: string;
  start: number;
  end: number;
}

export interface CollapsedPasteInsert {
  text: string;
  cursorOffset: number;
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

function sliceCodePoints(value: string, start?: number, end?: number): string {
  return codePoints(value).slice(start, end).join("");
}

function lineCount(value: string): number {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").length;
}

function characterCount(value: string): number {
  return codePoints(value).length;
}

export function shouldCollapsePaste(value: string): boolean {
  return (
    characterCount(value) >= COLLAPSED_PASTE_MIN_CHARS ||
    lineCount(value) >= COLLAPSED_PASTE_MIN_LINES
  );
}

function baseLabel(value: string): string {
  return `‹[Pasted ${characterCount(value).toLocaleString("en-US")} chars]›`;
}

export function textOffsetForCursor(text: string, cursor: { row: number; col: number }): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let row = 0; row < Math.min(cursor.row, lines.length); row += 1) {
    offset += characterCount(lines[row]) + 1;
  }
  return offset + Math.min(cursor.col, characterCount(lines[cursor.row] ?? ""));
}

export function cursorForTextOffset(text: string, rawOffset: number): { row: number; col: number } {
  const offset = Math.max(0, Math.min(rawOffset, characterCount(text)));
  const lines = text.split("\n");
  let consumed = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const length = characterCount(lines[row]);
    if (offset <= consumed + length) return { row, col: offset - consumed };
    consumed += length + 1;
  }
  const row = Math.max(0, lines.length - 1);
  return { row, col: characterCount(lines[row] ?? "") };
}

/**
 * Tracks hidden paste values by their exact display spans. Ordinary edits
 * before/after a label move the span; any edit touching the label invalidates
 * the hidden value and leaves the visible text as-is.
 */
export class CollapsedPasteStore {
  readonly #entries: CollapsedPaste[] = [];
  #lastText = "";

  insert(value: string, displayText: string, rawOffset: number): CollapsedPasteInsert {
    this.reconcile(displayText);
    const offset = Math.max(0, Math.min(rawOffset, characterCount(displayText)));
    const prefix = sliceCodePoints(displayText, 0, offset);
    const suffix = sliceCodePoints(displayText, offset);
    if (!shouldCollapsePaste(value)) {
      const text = `${prefix}${value}${suffix}`;
      this.#shiftEntries(offset, characterCount(value));
      this.#lastText = text;
      return { text, cursorOffset: offset + characterCount(value) };
    }

    const base = baseLabel(value);
    let label = base;
    let suffixNumber = 2;
    while (this.#entries.some((entry) => entry.label === label)) {
      label = `${base.slice(0, -2)} #${suffixNumber}]›`;
      suffixNumber += 1;
    }
    const labelLength = characterCount(label);
    this.#shiftEntries(offset, labelLength);
    this.#entries.push({
      label,
      original: value,
      start: offset,
      end: offset + labelLength,
    });
    this.#entries.sort((left, right) => left.start - right.start);
    const text = `${prefix}${label}${suffix}`;
    this.#lastText = text;
    return { text, cursorOffset: offset + labelLength };
  }

  reconcile(displayText: string): void {
    if (displayText === this.#lastText) return;
    const before = codePoints(this.#lastText);
    const after = codePoints(displayText);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const oldEnd = before.length - suffix;
    const newEnd = after.length - suffix;
    const delta = newEnd - oldEnd;
    const insertion = prefix === oldEnd;

    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index];
      if (insertion && prefix <= entry.start) {
        entry.start += delta;
        entry.end += delta;
      } else if (!insertion && oldEnd <= entry.start) {
        entry.start += delta;
        entry.end += delta;
      } else if (prefix >= entry.end) {
        continue;
      } else {
        this.#entries.splice(index, 1);
        continue;
      }
      if (sliceCodePoints(displayText, entry.start, entry.end) !== entry.label) {
        this.#entries.splice(index, 1);
      }
    }
    this.#lastText = displayText;
  }

  expand(displayText: string): string {
    this.reconcile(displayText);
    let offset = 0;
    let expanded = "";
    for (const entry of this.#entries) {
      expanded += sliceCodePoints(displayText, offset, entry.start);
      expanded += entry.original;
      offset = entry.end;
    }
    return expanded + sliceCodePoints(displayText, offset);
  }

  clear(): void {
    this.#entries.length = 0;
    this.#lastText = "";
  }

  #shiftEntries(offset: number, delta: number): void {
    for (const entry of this.#entries) {
      if (entry.start < offset) continue;
      entry.start += delta;
      entry.end += delta;
    }
  }
}
