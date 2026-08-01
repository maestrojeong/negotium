/**
 * Terminal colour-depth detection.
 *
 * The renderer's palette is authored in 24-bit RGB (`theme` in `render.ts`).
 * This module decides how much of that the attached terminal can actually
 * receive, and provides the RGB → 256 → 16 downshifts, so the palette itself
 * never has to be duplicated per depth.
 *
 * Detection happens once at process start (`render.ts` calls `detectColorDepth`
 * at module load). Runtime changes go through `setColorDepth`, which also
 * invalidates the message layout cache.
 */
export type ColorDepth = "none" | "ansi16" | "ansi256" | "truecolor";

const DEPTHS: readonly ColorDepth[] = ["none", "ansi16", "ansi256", "truecolor"];

function asDepth(value: string | undefined): ColorDepth | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return (DEPTHS as readonly string[]).includes(normalized) ? (normalized as ColorDepth) : null;
}

/**
 * `FORCE_COLOR` levels follow the `supports-color` convention:
 * `0` off, `1` 16 colours, `2` 256 colours, `3` truecolor. An empty value or
 * `true` means "colour is supported" without claiming a depth, i.e. level 1.
 */
function forceColorDepth(raw: string | undefined): ColorDepth | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "none") return "none";
  if (value === "" || value === "1" || value === "true") return "ansi16";
  if (value === "2") return "ansi256";
  if (value === "3") return "truecolor";
  return null;
}

export interface ColorDepthProbe {
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
}

/**
 * Resolution order (first match wins):
 *
 * | condition                                   | depth      |
 * |---------------------------------------------|------------|
 * | `NEGOTIUM_TUI_COLOR=none\|ansi16\|ansi256\|truecolor` | as named |
 * | `NO_COLOR` set to a non-empty value          | `none`     |
 * | `FORCE_COLOR` 0/1/2/3                        | as named   |
 * | `TERM=dumb`                                  | `none`     |
 * | stdout is not a TTY (pipe / redirect)        | `none`     |
 * | `COLORTERM` matches `truecolor` or `24bit`   | `truecolor`|
 * | `TERM` contains `truecolor` or `direct`      | `truecolor`|
 * | `TERM` contains `256color`                   | `ansi256`  |
 * | otherwise (a TTY of unknown capability)      | `ansi16`   |
 *
 * `NO_COLOR` follows https://no-color.org verbatim: *any* non-empty value
 * disables colour, and an empty value is treated as unset (the spec's
 * "present and not an empty string"). It deliberately outranks `FORCE_COLOR`
 * so an accessibility opt-out cannot be overridden by an inherited variable;
 * `NEGOTIUM_TUI_COLOR` is the single explicit escape hatch above both, matching
 * how `NEGOTIUM_TUI_DISABLE_KITTY_KEYBOARD` overrides capability guessing.
 */
export function detectColorDepth(probe: ColorDepthProbe = {}): ColorDepth {
  const env = probe.env ?? process.env;
  const isTty = probe.isTty ?? process.stdout?.isTTY === true;

  const override = asDepth(env.NEGOTIUM_TUI_COLOR);
  if (override) return override;

  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";

  const forced = forceColorDepth(env.FORCE_COLOR);
  if (forced) return forced;

  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return "none";
  if (!isTty) return "none";

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  if (term.includes("truecolor") || term.includes("direct")) return "truecolor";
  if (term.includes("256color")) return "ansi256";
  return "ansi16";
}

/**
 * xterm 256-colour index for an RGB triple: the 24-step grayscale ramp when the
 * channels are close enough to neutral, otherwise the 6×6×6 colour cube.
 */
export function rgbToAnsi256([r, g, b]: readonly [number, number, number]): number {
  if (Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8 && Math.abs(r - b) <= 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const level = (value: number): number =>
    Math.round((Math.max(0, Math.min(255, value)) / 255) * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

/**
 * Nearest of the 16 basic ANSI colours, as an index in 0..15 (0-7 normal, 8-15
 * bright).
 *
 * Hue and lightness are decided separately rather than by thresholding raw
 * channels, because this palette is full of *tinted* colours where a naive
 * threshold collapses the hue: `red` is a salmon (245,116,128) whose nearest
 * plain-RGB neighbour is white, and `selected` (42,37,69) would threshold to
 * white and paint a white block where a dark selection bar belongs.
 *
 *  - Low chroma (or near-black) is treated as achromatic and lands on the
 *    black / gray / white / bright-white ramp by lightness. This is what keeps
 *    `muted` (137,141,158 → 7) and `subtle` (91,95,112 → 8) apart, which the
 *    original survey called out as the pair most at risk of merging.
 *  - Otherwise each channel is compared against the midpoint between the
 *    darkest and brightest channel, so only the channels that actually carry
 *    the hue survive, and the maximum channel decides normal vs bright.
 *
 * Known lossy cases, all of which keep a non-colour cue: the three dark surface
 * tones and both diff backgrounds all become black (the `+`/`-` markers still
 * distinguish diff rows), and `surfaceRaised` stops separating the composer
 * from the canvas.
 */
export function rgbToAnsi16([r, g, b]: readonly [number, number, number]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma < 32 || max < 32) {
    if (max < 48) return 0;
    if (max < 140) return 8;
    if (max < 220) return 7;
    return 15;
  }
  const mid = min + chroma / 2;
  const code = (r > mid ? 1 : 0) | (g > mid ? 2 : 0) | (b > mid ? 4 : 0);
  return max >= 170 ? code + 8 : code;
}
