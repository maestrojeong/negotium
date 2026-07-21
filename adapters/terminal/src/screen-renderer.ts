const ESC = "\u001b[";
const DISABLE_AUTOWRAP = `${ESC}?7l`;
const ENABLE_AUTOWRAP = `${ESC}?7h`;

export function placeTerminalCursor(cursor: { x: number; y: number }): string {
  const x = Math.max(1, Math.trunc(cursor.x));
  const y = Math.max(1, Math.trunc(cursor.y));
  return `${ESC}${y};${x}H${ESC}?25h`;
}

/**
 * Produces small ANSI patches instead of clearing and repainting the terminal.
 *
 * Apple Terminal lays every full-screen write out through AppKit/CoreText. A
 * fast stream of clear-and-repaint frames can therefore make the terminal
 * application itself unstable. Keeping the previous frame also avoids the
 * flicker that a full clear introduces in every terminal emulator.
 */
export class TerminalScreenRenderer {
  #previousLines: string[] = [];
  #invalidated = true;

  invalidate(): void {
    this.#invalidated = true;
  }

  reset(): void {
    this.#previousLines = [];
    this.#invalidated = true;
  }

  update(frame: string, terminalRows?: number): string {
    const lines = frame.split("\n");
    const previous = this.#previousLines;
    const redrawAll = this.#invalidated;
    const storedRowCount = Math.max(lines.length, previous.length);
    const physicalRowCount = Math.max(1, Math.trunc(terminalRows ?? storedRowCount));
    const rowCount = Math.min(storedRowCount, physicalRowCount);
    let output = "";

    for (let index = 0; index < rowCount; index += 1) {
      const current = lines[index];
      if (!redrawAll && current === previous[index]) continue;

      // Move before erasing. This also cancels a pending auto-wrap after a
      // full-width line without relying on newline behavior.
      const row = index + 1;
      const content = current ?? "";
      output += `${ESC}${row};1H${ESC}2K`;
      if (row === physicalRowCount) {
        // A printable character in the terminal's final cell can leave VT
        // autowrap pending. Keep the complete row, but prevent that state from
        // escaping this write; the next cursor move is then repaint-only.
        output += `${DISABLE_AUTOWRAP}${content}${ENABLE_AUTOWRAP}`;
      } else {
        output += content;
      }
    }

    if (output) output += `${ESC}H`;
    this.#previousLines = lines;
    this.#invalidated = false;
    return output;
  }
}
