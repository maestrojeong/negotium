/**
 * A real shell running in a pseudo-terminal, shown as the TUI's right-hand
 * pane — herdr's panes are live terminals next to its sidebar, and this is the
 * same idea for one shell beside the conversation.
 *
 * The PTY is Bun's built-in `Bun.Terminal` (no native addon to build), and its
 * output is interpreted by `@xterm/headless`, which keeps the screen buffer,
 * scrollback, cursor and modes. The pane never writes to the real terminal
 * itself: `snapshot()` turns the visible buffer into styled runs and the
 * renderer paints them into the frame like any other column, so the line-diff
 * renderer, selection and resize handling all keep working unchanged.
 */

import xterm from "@xterm/headless";

type XtermTerminal = import("@xterm/headless").Terminal;
type XtermCell = import("@xterm/headless").IBufferCell;

export type ShellColor =
  | { kind: "default" }
  | { kind: "palette"; index: number }
  | { kind: "rgb"; rgb: readonly [number, number, number] };

export interface ShellRun {
  text: string;
  /** Terminal columns the run occupies (wide characters count twice). */
  width: number;
  fg: ShellColor;
  bg: ShellColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface ShellSnapshot {
  cols: number;
  rows: number;
  /** One entry per visible row, each exactly `cols` wide. */
  lines: ShellRun[][];
  /** Cursor inside the pane (zero-based), or null when hidden or scrolled back. */
  cursor: { x: number; y: number } | null;
}

/** The slice of `Bun.Terminal` this module uses (absent before Bun 1.3.5). */
interface PtyHandle {
  write(data: string | Uint8Array): number | undefined;
  resize(cols: number, rows: number): void;
  close(): void;
}

type PtyConstructor = new (options: {
  cols: number;
  rows: number;
  data: (terminal: unknown, data: Uint8Array) => void;
}) => PtyHandle;

interface ShellProcess {
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface ShellPaneOptions {
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  /** Called whenever the visible buffer may have changed. */
  onChange: () => void;
  /** Called once the shell process has exited (e.g. the user typed `exit`). */
  onExit: (code: number) => void;
}

/** The PTY constructor if this Bun has one; `Bun.Terminal` landed in Bun 1.3.5. */
export function ptySupport(): PtyConstructor | null {
  const candidate = (globalThis as { Bun?: { Terminal?: unknown } }).Bun?.Terminal;
  return typeof candidate === "function" ? (candidate as PtyConstructor) : null;
}

const DEFAULT_COLOR: ShellColor = { kind: "default" };

function cellColor(isDefault: boolean, isPalette: boolean, isRgb: boolean, value: number) {
  if (isDefault) return DEFAULT_COLOR;
  if (isPalette) return { kind: "palette", index: value } as const;
  if (isRgb) {
    return {
      kind: "rgb",
      rgb: [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff],
    } as const;
  }
  return DEFAULT_COLOR;
}

function sameColor(a: ShellColor, b: ShellColor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "palette" && b.kind === "palette") return a.index === b.index;
  if (a.kind === "rgb" && b.kind === "rgb") {
    return a.rgb[0] === b.rgb[0] && a.rgb[1] === b.rgb[1] && a.rgb[2] === b.rgb[2];
  }
  return true;
}

function sameStyle(a: ShellRun, b: Omit<ShellRun, "text" | "width">): boolean {
  return (
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg) &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse
  );
}

function blankRun(width: number): ShellRun {
  return {
    text: " ".repeat(width),
    width,
    fg: DEFAULT_COLOR,
    bg: DEFAULT_COLOR,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

/** Bytes a bracketed-paste-aware program expects around pasted text. */
export function shellPastePayload(text: string, bracketed: boolean): string {
  // A pasted end marker would let the payload "escape" the paste early.
  const safe = text.replaceAll("\u001b[201~", "");
  return bracketed ? `\u001b[200~${safe}\u001b[201~` : safe;
}

export class ShellPane {
  readonly #xterm: XtermTerminal;
  readonly #pty: PtyHandle;
  readonly #process: ShellProcess;
  #cols: number;
  #rows: number;
  #disposed = false;

  constructor(options: ShellPaneOptions) {
    const Pty = ptySupport();
    if (!Pty) throw new Error("the shell pane needs Bun >= 1.3.5 (Bun.Terminal)");
    this.#cols = Math.max(2, options.cols);
    this.#rows = Math.max(1, options.rows);
    const Terminal = (xterm as unknown as { Terminal: typeof import("@xterm/headless").Terminal })
      .Terminal;
    this.#xterm = new Terminal({
      cols: this.#cols,
      rows: this.#rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.#pty = new Pty({
      cols: this.#cols,
      rows: this.#rows,
      data: (_terminal, data) => {
        if (this.#disposed) return;
        this.#xterm.write(data, options.onChange);
      },
    });
    // Replies the program asked for (cursor-position / device-attribute
    // queries) go back to it, the way a real terminal would answer them.
    this.#xterm.onData((data) => {
      if (!this.#disposed) this.#pty.write(data);
    });
    const shell = options.shell || process.env.SHELL || "/bin/zsh";
    const env = { ...(options.env ?? process.env) };
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    // Nothing in the pane should believe it is still inside the TUI's own
    // terminal session, e.g. Terminal.app's per-session restore hooks.
    delete env.TERM_SESSION_ID;
    const spawn = (
      globalThis as unknown as { Bun: { spawn: (...args: unknown[]) => ShellProcess } }
    ).Bun.spawn;
    this.#process = spawn([shell, "-l"], {
      cwd: options.cwd ?? process.cwd(),
      env,
      terminal: this.#pty,
    });
    void this.#process.exited.then((code) => {
      if (this.#disposed) return;
      this.dispose();
      options.onExit(code);
    });
  }

  get cols(): number {
    return this.#cols;
  }

  get rows(): number {
    return this.#rows;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Keyboard input for the shell. Snaps the view back to the live screen. */
  write(data: string): void {
    if (this.#disposed || !data) return;
    this.#xterm.scrollToBottom();
    this.#pty.write(data);
  }

  paste(text: string): void {
    this.write(shellPastePayload(text, this.#xterm.modes.bracketedPasteMode));
  }

  /** Positive `delta` scrolls back into history, negative toward the live screen. */
  scroll(delta: number): void {
    if (this.#disposed || delta === 0) return;
    this.#xterm.scrollLines(-delta);
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(2, cols);
    const nextRows = Math.max(1, rows);
    if (this.#disposed || (nextCols === this.#cols && nextRows === this.#rows)) return;
    this.#cols = nextCols;
    this.#rows = nextRows;
    this.#xterm.resize(nextCols, nextRows);
    this.#pty.resize(nextCols, nextRows);
  }

  snapshot(): ShellSnapshot {
    const buffer = this.#xterm.buffer.active;
    const lines: ShellRun[][] = [];
    let reusable: XtermCell | undefined;
    for (let y = 0; y < this.#rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      const runs: ShellRun[] = [];
      let used = 0;
      if (line) {
        for (let x = 0; x < this.#cols; x += 1) {
          const cell = line.getCell(x, reusable);
          if (!cell) break;
          reusable = cell;
          const width = cell.getWidth();
          // The right half of a wide character is carried by its left half.
          if (width === 0) continue;
          if (used + width > this.#cols) break;
          const style = {
            fg: cellColor(
              cell.isFgDefault(),
              cell.isFgPalette(),
              cell.isFgRGB(),
              cell.getFgColor(),
            ),
            bg: cellColor(
              cell.isBgDefault(),
              cell.isBgPalette(),
              cell.isBgRGB(),
              cell.getBgColor(),
            ),
            bold: cell.isBold() !== 0,
            dim: cell.isDim() !== 0,
            italic: cell.isItalic() !== 0,
            underline: cell.isUnderline() !== 0,
            inverse: cell.isInverse() !== 0,
          };
          const text = cell.getChars() || " ";
          const last = runs[runs.length - 1];
          if (last && sameStyle(last, style)) {
            last.text += text;
            last.width += width;
          } else {
            runs.push({ text, width, ...style });
          }
          used += width;
        }
      }
      if (used < this.#cols) runs.push(blankRun(this.#cols - used));
      lines.push(runs);
    }
    const atLiveScreen = buffer.viewportY === buffer.baseY;
    const hidden = (
      this.#xterm as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } }
    )._core?.coreService?.isCursorHidden;
    return {
      cols: this.#cols,
      rows: this.#rows,
      lines,
      cursor:
        atLiveScreen && !hidden
          ? { x: Math.min(buffer.cursorX, this.#cols - 1), y: buffer.cursorY }
          : null,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#process.kill();
    } catch {
      // Already gone.
    }
    try {
      this.#pty.close();
    } catch {
      // Already closed.
    }
    this.#xterm.dispose();
  }
}
