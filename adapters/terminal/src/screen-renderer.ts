const ESC = "\u001b[";
const DISABLE_AUTOWRAP = `${ESC}?7l`;
const ENABLE_AUTOWRAP = `${ESC}?7h`;

/**
 * DECSET 2026 (synchronized output). The terminal buffers everything between
 * begin and end and presents it as one atomic update, so a multi-row patch is
 * never shown half-drawn. Terminals that do not implement the mode ignore both
 * sequences, so no capability probe is needed.
 */
export const BEGIN_SYNCHRONIZED_UPDATE = `${ESC}?2026h`;
export const END_SYNCHRONIZED_UPDATE = `${ESC}?2026l`;

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

  /**
   * `cursor` is where the caret belongs once the patch has been applied.
   * Placing it here rather than in a separate write keeps it inside the
   * synchronized block, and lets the patch tell whether it ever moved the
   * caret off that row — the only case that needs DECTCEM toggling.
   */
  update(frame: string, terminalRows?: number, cursor?: { x: number; y: number } | null): string {
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

    // Wrap the whole patch so the terminal never presents a partially drawn
    // frame, and finish by putting the caret where it belongs — inside the
    // block, not after it.
    //
    // Ending the block on the home move and placing the caret in a separate
    // write is what made it strobe at the top-left: the terminal was handed a
    // complete, atomic frame whose caret sat at 1;1, drew it, and only then
    // received the move. That is a resting state, not a transient one, so
    // synchronized output could not hide it. Nothing needs to toggle DECTCEM
    // for this — and toggling per frame would restart the terminal's blink
    // phase, which reads as a stutter while typing.
    //
    // The move still doubles as the pending-autowrap guard the final row needs.
    if (output) {
      const tail = cursor ? placeTerminalCursor(cursor) : `${ESC}H`;
      output = `${BEGIN_SYNCHRONIZED_UPDATE}${output}${tail}${END_SYNCHRONIZED_UPDATE}`;
    }
    this.#previousLines = lines;
    this.#invalidated = false;
    return output;
  }
}
