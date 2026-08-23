import { EFFORT_VALUES, getRegistry, type RuntimeBusEvent, type TopicDto } from "@negotium/core";
import type { NegotiumClient } from "@/client";
import { terminalNowMs } from "@/clock";
import type { CodeCopyTarget } from "@/render";
import { RENDERED_TAB_WIDTH, WORKING_FRAME_INTERVAL_MS } from "@/render";
import type { ScreenPoint } from "@/selection";
import { type AppState, activeTopic } from "@/state";

const MESSAGE_MUTATING_AI_STATUS_KINDS = new Set(["tool_call", "tool_output"]);
// Mouse coordinates are bounded so a pasted digit run can never be swallowed as
// one gigantic "mouse report"; real SGR reports stay well inside five digits.
// biome-ignore lint/complexity/useRegexLiterals: avoids a literal terminal control byte in source.
const SGR_MOUSE_PATTERN = new RegExp("\\u001b\\[<(\\d{1,5});(\\d{1,5});(\\d{1,5})([mM])", "g");
const TERMINAL_VAULT_USAGE =
  "Usage: /vault, /vault list, /vault set KEY VALUE [description], or /vault del KEY";

export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * Spaces substituted for a pasted tab. See {@link sanitizePastedText}.
 *
 * Aliases the renderer's expansion so a pasted tab and a tab arriving through
 * tool output collapse to the same number of columns.
 */
export const PASTED_TAB_WIDTH = RENDERED_TAB_WIDTH;

const ESC = "\\u001b";
/** The ESC byte itself. `ESC` above is its regex-source spelling. */
const ESC_CHAR = "\u001b";
const BEL = "\\u0007";
// OSC / DCS / APC style strings: only stripped when a terminator is present, so
// a bare `ESC ]` inside pasted prose can never eat the rest of the payload.
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]{0,1024}(?:${BEL}|${ESC}\\\\)`, "g");
const STRING_COMMAND_PATTERN = new RegExp(`${ESC}[P^_X][^${ESC}]{0,1024}${ESC}\\\\`, "g");
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-?]{0,32}[ -/]{0,4}[@-~]`, "g");
const SS3_PATTERN = new RegExp(`${ESC}O[ -~]`, "g");
const LONE_ESCAPE_PATTERN = new RegExp(ESC, "g");
// Everything below 0x20 except tab/newline, plus DEL and the C1 block.
// biome-ignore lint/complexity/useRegexLiterals: avoids literal terminal control bytes in source.
const REMAINING_CONTROL_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]",
  "g",
);

/**
 * Strips terminal control sequences from an explicit paste before it reaches the
 * composer, so nothing corrupt is sent to the model, persisted to the input
 * history, or replayed into scrollback. Mirrors codex #31494.
 *
 * Printable characters are never dropped. `\r\n` and `\r` collapse to `\n`, and
 * tabs become {@link PASTED_TAB_WIDTH} spaces: `displayWidth` counts a tab as one
 * column while a real terminal advances to the next tab stop, which would drift
 * the composer cursor and the Hangul preedit anchor.
 *
 * The tab substitution is a deliberate, reviewed trade-off, not an oversight:
 * pasting TSV (a spreadsheet selection) loses its column separators. Keeping the
 * tab byte would mean teaching `displayWidth`/`wrapText`/`wrapLineWithCursor`
 * about tab stops in lockstep, and that is the same width-measurement path the
 * narrow-terminal overflow fix just stabilised. Mangling a rare paste shape was
 * judged cheaper than destabilising every width calculation. Revisit — by fixing
 * `displayWidth` rather than by simply passing the tab through — if pasted
 * tabular data turns out to matter in practice.
 *
 * The renderer applies the same substitution in `safeText`, because a tab that
 * arrives through tool output (an Edit preview of a tab-indented file) overflows
 * its pane for exactly the same reason. Both sides share {@link RENDERED_TAB_WIDTH}.
 */
export function sanitizePastedText(value: string): string {
  return value
    .replace(OSC_PATTERN, "")
    .replace(STRING_COMMAND_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(SS3_PATTERN, "")
    .replace(LONE_ESCAPE_PATTERN, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\t", " ".repeat(PASTED_TAB_WIDTH))
    .replace(REMAINING_CONTROL_PATTERN, "");
}

export type TerminalInputSegment =
  /** Bytes outside a bracketed paste: safe to hand to the key/mouse parsers. */
  | { kind: "keys"; text: string }
  /** Paste payload with no terminator yet; buffer it verbatim. */
  | { kind: "paste-chunk"; text: string }
  /** Final paste payload slice; buffer it verbatim, then commit the paste. */
  | { kind: "paste-end"; text: string };

/**
 * Longest proper prefix of `marker` that `text` ends with, or 0.
 *
 * Used for the paste *end* marker only. Inside a paste the payload has to reach
 * the composer byte for byte, so it is never handed to the escape tokenizer —
 * an SGR mouse report inside pasted text must not be parsed as a click. That
 * leaves exactly one thing to look for at the tail: a torn `ESC [ 2 0 1 ~`.
 */
function partialMarkerSuffix(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Upper bound on a held-back escape fragment.
 *
 * Real sequences are far shorter: the longest we handle is an SGR mouse report
 * (`ESC [ < 0 ; 1234 ; 1234 M`, 18 bytes). The cap is what stops a terminal
 * that starts an escape sequence and never finishes it from accumulating input
 * forever — past it the bytes are released to the key parser as ordinary text,
 * which is what they turned out to be.
 */
const MAX_ESCAPE_CARRY = 32;

/**
 * Length of the trailing *incomplete* escape sequence in `text`, or 0.
 *
 * stdin reads split wherever the buffer happens to end, so any sequence can
 * arrive in halves. This matters far more since the kitty keyboard protocol
 * went in: `DISAMBIGUATE_ESCAPE_CODES` turns Ctrl-C into the seven bytes
 * `ESC [ 9 9 ; 5 u`, so a chunk boundary inside it used to lose the chord *and*
 * type `5u` into the composer. Holding the fragment back and re-scanning it
 * with the next chunk is what makes the parse independent of chunking.
 *
 * Only the last `ESC` can be incomplete — anything before it has already been
 * closed by a final byte or is plain text — so this examines that tail alone:
 *
 *  - `ESC` on its own: could still become anything.
 *  - `ESC O` (SS3): needs exactly one more byte.
 *  - `ESC [` (CSI): parameter bytes `0x30-0x3F` and intermediates `0x20-0x2F`
 *    until a final byte `0x40-0x7E`. This one rule covers cursor keys, `~`
 *    keys, kitty CSI-u, SGR mouse reports (`ESC [ <` … `m`/`M`) and the
 *    bracketed-paste markers alike.
 *  - `ESC` followed by anything else is the two-byte Alt-key form: complete.
 *
 * A byte that cannot appear in a CSI ends the scan as "not a sequence", so a
 * fragment that only looked like one (`ESC [ 9 9 ;` followed by `q`) is passed
 * through whole instead of being dropped.
 */
function incompleteEscapeSuffix(text: string): number {
  const start = text.lastIndexOf(ESC_CHAR);
  if (start < 0) return 0;
  const length = text.length - start;
  if (length > MAX_ESCAPE_CARRY) return 0;
  if (length === 1) return 1;
  const introducer = text[start + 1];
  if (introducer === "O") return length === 2 ? 2 : 0;
  if (introducer !== "[") return 0;
  for (let index = start + 2; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return 0;
    if (code < 0x20 || code > 0x3f) return 0;
  }
  return length;
}

/**
 * Splits a raw stdin chunk on bracketed-paste markers. Paste payloads are
 * returned untouched so the mouse/key parsers never see them — otherwise an SGR
 * mouse report embedded in pasted text is consumed as a real click.
 *
 * Streaming decoder: `pasting` *and* `carry` are the parser state and must both
 * be threaded back in by the caller. `carry` holds a trailing fragment that is
 * an unfinished escape sequence (see {@link incompleteEscapeSuffix}) or, inside
 * a paste, an unfinished end marker. It is re-scanned with the next chunk, so a
 * sequence split at any byte boundary still parses as one unit and a fragment
 * that turns out not to be a sequence is emitted intact — nothing is dropped.
 *
 * A caller that stops receiving input while `carry` is non-empty must flush it
 * (see `TerminalApp.#flushInputCarry`), otherwise a lone `ESC` — which cannot be
 * told apart from the first byte of a longer sequence until more input arrives —
 * would never reach the key handler.
 */
export function splitBracketedPaste(
  raw: string,
  pasting: boolean,
  carry = "",
): { segments: TerminalInputSegment[]; pasting: boolean; carry: string } {
  const buffer = carry + raw;
  const segments: TerminalInputSegment[] = [];
  let index = 0;
  let inPaste = pasting;
  let pending = "";
  while (index < buffer.length) {
    const marker = inPaste ? BRACKETED_PASTE_END : BRACKETED_PASTE_START;
    const found = buffer.indexOf(marker, index);
    if (found >= 0) {
      if (inPaste) segments.push({ kind: "paste-end", text: buffer.slice(index, found) });
      else if (found > index) segments.push({ kind: "keys", text: buffer.slice(index, found) });
      index = found + marker.length;
      inPaste = !inPaste;
      continue;
    }
    const rest = buffer.slice(index);
    // Inside a paste only the end marker may be torn; outside it, any escape
    // sequence may be. The paste payload never reaches the tokenizer.
    const held = inPaste ? partialMarkerSuffix(rest, marker) : incompleteEscapeSuffix(rest);
    const text = held > 0 ? rest.slice(0, rest.length - held) : rest;
    pending = held > 0 ? rest.slice(rest.length - held) : "";
    if (text) segments.push({ kind: inPaste ? "paste-chunk" : "keys", text });
    break;
  }
  return { segments, pasting: inPaste, carry: pending };
}

const SS3_CURSOR_PATTERN = new RegExp(`${ESC}O([A-DHF])`, "g");

// --- kitty keyboard protocol, DISAMBIGUATE_ESCAPE_CODES (flag 1) -------------
//
// Pushing `CSI > 1 u` changes the wire form of keys the dispatch table matches
// literally, so everything below exists to translate them back before dispatch.
// The rules come from the kitty spec (docs/keyboard-protocol.rst) cross-checked
// against the reference encoder (kitty/key_encoding.c, `encode_function_key` /
// `encode_key`), not from guesswork:
//
//   "Turning on this flag will cause the terminal to report the Esc, alt+key,
//    ctrl+key, ctrl+alt+key, shift+alt+key keys using CSI u sequences instead of
//    legacy ones. [...] The only exceptions are the Enter, Tab and Backspace
//    keys which still generate the same bytes as in legacy mode"
//
// key_encoding.c makes that exception precise: the legacy bytes survive only
// while `!(mods & ~LOCK_MASK)`, i.e. only unmodified. *Modified* Enter, Tab and
// Backspace do become `CSI 13/9/127 ; mods u` — which is exactly how Shift-Enter
// becomes expressible at all.
//
// Two consequences that are easy to miss:
//   * ctrl+letter no longer arrives as a C0 byte. Ctrl-C is `CSI 99;5u`, not
//     0x03. negotium binds ~14 Ctrl chords, so without this table they all die.
//   * With any keyboard flag pushed, kitty stops masking the lock modifiers
//     (`convert_glfw_mods`: `if (!key_encoding_flags) mods &= ~GLFW_LOCK_MASK`).
//     Caps Lock on turns Ctrl-C into `CSI 99;69u` and Up into `CSI 1;65A`, so the
//     lock bits are stripped before anything else is decided.
const MOD_SHIFT = 1;
const MOD_ALT = 2;
const MOD_CTRL = 4;
const MOD_LOCKS = 0b1100_0000; // caps_lock | num_lock
const MOD_EXOTIC = 0b0011_1000; // super | hyper | meta — no legacy encoding exists

/** kitty "Legacy ctrl mapping of ASCII keys" table (docs/keyboard-protocol.rst). */
const CTRL_BYTES = new Map<number, number>([
  [0x20, 0], // space
  [0x2f, 31], // /
  [0x30, 48], // 0
  [0x31, 49], // 1
  [0x32, 0], // 2
  [0x33, 27], // 3
  [0x34, 28], // 4
  [0x35, 29], // 5
  [0x36, 30], // 6
  [0x37, 31], // 7
  [0x38, 127], // 8
  [0x39, 57], // 9
  [0x3f, 127], // ?
  [0x40, 0], // @
  [0x5b, 27], // [
  [0x5c, 28], // backslash
  [0x5d, 29], // ]
  [0x5e, 30], // ^
  [0x5f, 31], // _
  [0x7e, 30], // ~
]);

/**
 * The ASCII keys kitty encodes with the legacy algorithm when unenhanced.
 * Space is on the list because the spec calls it out separately:
 * "Additionally, ctrl+space is output as the NULL byte (0x0)".
 */
const LEGACY_TEXT_KEYS = new Set<number>(
  [...("abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./ " as string)].map(
    (character) => character.codePointAt(0) as number,
  ),
);

function ctrlByte(codePoint: number): number | null {
  if (codePoint >= 0x61 && codePoint <= 0x7a) return codePoint - 0x60; // a-z -> 1..26
  return CTRL_BYTES.get(codePoint) ?? null;
}

/** Decodes the `1 + bitmask` modifier field, discarding caps/num lock. */
function decodeModifiers(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) return 0;
  return (value - 1) & ~MOD_LOCKS;
}

function encodeModifiers(mods: number): string {
  return String(mods + 1);
}

/**
 * Maps one `CSI <codepoint> ; <mods> u` event back to the legacy bytes the
 * dispatch table already understands, or returns `null` to leave it alone.
 */
function legacyFormForCsiU(codePoint: number, mods: number): string | null {
  if (mods & MOD_EXOTIC) return null;
  const shift = (mods & MOD_SHIFT) !== 0;
  const alt = (mods & MOD_ALT) !== 0;
  const ctrl = (mods & MOD_CTRL) !== 0;
  const meta = alt ? ESC_CHAR : "";

  switch (codePoint) {
    case 27:
      // Escape. Every row of the spec's C0 table is a bare ESC, doubled under alt.
      return `${meta}${ESC_CHAR}`;
    case 13:
      // Enter. Shift/Ctrl-Enter must stay in CSI-u form: collapsing them to CR
      // would throw away the one distinction we enabled the protocol for.
      if (shift || ctrl) return null;
      return `${meta}\r`;
    case 9:
      // Tab. Shift-Tab has a legacy form of its own.
      if (shift) return `${meta}${ESC_CHAR}[Z`;
      return `${meta}\t`;
    case 127:
      // Backspace: DEL normally, BS under ctrl.
      return `${meta}${ctrl ? "\b" : ""}`;
    default:
      break;
  }

  if (!LEGACY_TEXT_KEYS.has(codePoint)) return null;
  // kitty's legacy text-key algorithm: ESC prefix for alt, then the ctrl
  // mapping, else the shifted glyph, else the key itself. Only those modifier
  // combinations have a legacy form; per spec anything else stays CSI u.
  if (ctrl && shift) return null;
  if (ctrl) {
    const byte = ctrlByte(codePoint);
    return byte === null ? null : `${meta}${String.fromCharCode(byte)}`;
  }
  if (shift) {
    // Without REPORT_ALTERNATE_KEYS the terminal never tells us the shifted
    // glyph, so only letters (layout independent) can be reconstructed.
    if (codePoint < 0x61 || codePoint > 0x7a) return null;
    return `${meta}${String.fromCodePoint(codePoint - 0x20)}`;
  }
  if (!alt) return null; // an unmodified text key never arrives as CSI u
  return `${meta}${String.fromCodePoint(codePoint)}`;
}

// `CSI <number> [;<mods>] u`. Sub-parameters (`:`) cannot occur with flag 1
// alone, but are tolerated and dropped so an outer app that pushed richer flags
// cannot wedge the parser.
const CSI_U_PATTERN = new RegExp(`${ESC}\\[(\\d+)(?::\\d+)*(?:;(\\d+)(?::\\d+)*)?u`, "g");
// `CSI 1;<mods> <letter>` — arrows/Home/End/F1-F4 grow a modifier field the
// moment Caps Lock is on, which would otherwise stop matching `ESC [ A`.
const CSI_LETTER_PATTERN = new RegExp(`${ESC}\\[1;(\\d+)(?::\\d+)*([A-Z])`, "g");
// `CSI <number>;<mods> ~` — same story for Delete/PgUp/PgDn/F5 and up.
const CSI_TILDE_PATTERN = new RegExp(`${ESC}\\[(\\d+);(\\d+)(?::\\d+)*~`, "g");

/**
 * Rewrites keyboard-protocol variants into the single form the dispatch table
 * matches. Runs exactly once, immediately before dispatch, so every downstream
 * comparison keeps working against plain legacy bytes.
 *
 * Covers SS3 cursor/navigation keys (`ESC O A`) from terminals left in DECCKM
 * application-cursor mode, and the `CSI u` forms produced by the kitty
 * `DISAMBIGUATE_ESCAPE_CODES` flag we push on entering the alt screen.
 */
export function normalizeKeySequences(chunk: string): string {
  return chunk
    .replace(SS3_CURSOR_PATTERN, (_match, final: string) => `${ESC_CHAR}[${final}`)
    .replace(CSI_U_PATTERN, (match, code: string, rawMods: string | undefined) => {
      const codePoint = Number.parseInt(code, 10);
      if (!Number.isFinite(codePoint)) return match;
      const mods = decodeModifiers(rawMods);
      const legacy = legacyFormForCsiU(codePoint, mods);
      if (legacy !== null) return legacy;
      // Keep the event but in canonical form, so matchers written against
      // `ESC [ 13 ; 2 u` still fire when Caps Lock inflated the modifier field.
      return mods === 0
        ? `${ESC_CHAR}[${codePoint}u`
        : `${ESC_CHAR}[${codePoint};${encodeModifiers(mods)}u`;
    })
    .replace(CSI_LETTER_PATTERN, (_match, rawMods: string, final: string) => {
      const mods = decodeModifiers(rawMods);
      return mods === 0 ? `${ESC_CHAR}[${final}` : `${ESC_CHAR}[1;${encodeModifiers(mods)}${final}`;
    })
    .replace(CSI_TILDE_PATTERN, (_match, code: string, rawMods: string) => {
      const mods = decodeModifiers(rawMods);
      return mods === 0 ? `${ESC_CHAR}[${code}~` : `${ESC_CHAR}[${code};${encodeModifiers(mods)}~`;
    });
}

// The only newline keys that actually reach us in a plain legacy terminal.
// `ESC CR` / `ESC LF` is the near-universal metaSendsEscape Alt-Enter form, and a
// bare LF is Ctrl-J (plus Ctrl-Enter on terminals that map it to LF).
const NEWLINE_KEY_CHUNKS = new Set<string>(["\u001b\r", "\u001b\n", "\n"]);

// CSI-u (`ESC [ 13 ; <mods> u`) and xterm modifyOtherKeys
// (`ESC [ 27 ; <mods> ; 13 ~`) encodings of a modified Return.
//
// Expectation check: in a pure legacy terminal Shift+Enter and Ctrl+Enter are
// physically indistinguishable from Enter — all three collapse to a single CR
// (0x0d), because ASCII control codes carry no modifier bits. These sequences
// only arrive once some keyboard-protocol negotiation is active.
//
// `app.ts` now pushes kitty `DISAMBIGUATE_ESCAPE_CODES` (`CSI > 1 u`) on
// entering the alt screen, so on a terminal that implements the protocol this
// branch is the normal path, not a lucky accident — which is why `helpLines()`
// does advertise Shift-Enter. It still will not fire when:
//   * the terminal ignores the push (Apple Terminal), or
//   * `NEGOTIUM_TUI_DISABLE_KITTY_KEYBOARD=1` turned the push off.
// In those cases Alt-Enter remains the only newline key, hence the hint text
// naming both.
//
// The xterm modifyOtherKeys form (`ESC [ 27 ; <mods> ; 13 ~`) is kept even
// though negotium never requests it: tmux with `extended-keys-format=csi-u`, or
// an outer app that already pushed those flags, can deliver it, and the user may
// hand-map the key (iTerm2 "Send Text", Ghostty/WezTerm keybinds).
const MODIFIED_ENTER_PATTERN = new RegExp(`^(?:${ESC}\\[13;[2-9]u|${ESC}\\[27;[2-9];13~)$`);

/** True when the chunk is an "insert a newline instead of submitting" key. */
export function terminalNewlineShortcut(chunk: string): boolean {
  return NEWLINE_KEY_CHUNKS.has(chunk) || MODIFIED_ENTER_PATTERN.test(chunk);
}

export function selectableEfforts(topic: TopicDto | null) {
  return topic?.agent ? getRegistry(topic.agent).validEfforts : EFFORT_VALUES;
}

export function maestroVaultKeyForModel(
  model: string,
): "DEEPSEEK_API_KEY" | "MOONSHOT_API_KEY" | null {
  if (model.startsWith("kimi")) return "MOONSHOT_API_KEY";
  if (model.startsWith("deepseek")) return "DEEPSEEK_API_KEY";
  return null;
}

export function vaultFormBlocksOverlaySwitch(
  state: Pick<AppState, "overlay" | "vaultMode">,
): boolean {
  return (
    state.overlay === "vault" && (state.vaultMode === "value" || state.vaultMode === "description")
  );
}

export function pasteCollapseDisabled(state: Pick<AppState, "creatingTopic" | "overlay">): boolean {
  return state.creatingTopic || state.overlay === "vault";
}

export type TerminalDeletionShortcut = "word-left" | "line-left";

export function terminalDeletionShortcut(chunk: string): TerminalDeletionShortcut | null {
  if (
    chunk === "\u0017" ||
    chunk === "\u001b\u007f" ||
    chunk === "\u001b\b" ||
    chunk === "\u001b[127;3u" ||
    chunk === "\u001b[8;3u" ||
    chunk === "\u001b[27;3;127~" ||
    chunk === "\u001b[27;3;8~"
  ) {
    return "word-left";
  }
  if (
    chunk === "\u0015" ||
    chunk === "\u001b[127;9u" ||
    chunk === "\u001b[8;9u" ||
    chunk === "\u001b[27;9;127~" ||
    chunk === "\u001b[27;9;8~"
  ) {
    return "line-left";
  }
  return null;
}

export type TerminalVaultCommandOutcome =
  | { kind: "open-manager" }
  | { kind: "notice"; notice: string };

export async function runTerminalVaultCommand(
  client: Pick<NegotiumClient, "runVaultCommand">,
  commandLine: string,
): Promise<TerminalVaultCommandOutcome> {
  const match = commandLine.trim().match(/^\/vault(?:@\w+)?(?:\s+([^\s]+))?/i);
  const subcommand = match?.[1]?.toLowerCase();

  if (!subcommand) return { kind: "open-manager" };
  if (subcommand !== "list" && subcommand !== "set" && subcommand !== "del") {
    return { kind: "notice", notice: TERMINAL_VAULT_USAGE };
  }
  if (!client.runVaultCommand) {
    return { kind: "notice", notice: "Vault commands are unavailable for this client." };
  }

  try {
    const output = await client.runVaultCommand(commandLine);
    return {
      kind: "notice",
      notice: output?.replace(/\s+/g, " ").trim() || "Vault command completed.",
    };
  } catch {
    return { kind: "notice", notice: "Vault command failed. Check the node connection." };
  }
}

export interface TerminalMouseEvent extends ScreenPoint {
  button: number;
  kind: "press" | "drag" | "release";
}

export function runtimeEventWaitsForMessageLoad(event: RuntimeBusEvent): boolean {
  if (event.type === "message" || event.type === "message-updated") return true;
  if (event.type !== "ai-status") return false;
  const payload = event.payload as { kind?: unknown } | null;
  return typeof payload?.kind === "string" && MESSAGE_MUTATING_AI_STATUS_KINDS.has(payload.kind);
}

export function runtimeEventInvalidatesSelection(
  state: Pick<AppState, "activeTopicId">,
  event: Pick<RuntimeBusEvent, "topicId">,
): boolean {
  return event.topicId === state.activeTopicId;
}

export function animationFrameAt(nowMs = terminalNowMs()): number {
  return Math.floor(nowMs / WORKING_FRAME_INTERVAL_MS);
}

export function consumeMouseInput(raw: string): {
  input: string;
  scrollDelta: number;
  horizontalScrollDelta: number;
  events: TerminalMouseEvent[];
} {
  let scrollDelta = 0;
  let horizontalScrollDelta = 0;
  const events: TerminalMouseEvent[] = [];
  const input = raw.replace(
    SGR_MOUSE_PATTERN,
    (_sequence, rawButton: string, rawX: string, rawY: string, suffix: string) => {
      const button = Number.parseInt(rawButton, 10);
      if (Number.isFinite(button) && (button & 64) !== 0) {
        const delta = (button & 1) === 0 ? 3 : -3;
        const horizontal = (button & 2) !== 0 || (button & 4) !== 0;
        if (horizontal) horizontalScrollDelta += delta;
        else scrollDelta += delta;
      } else {
        const x = Number.parseInt(rawX, 10);
        const y = Number.parseInt(rawY, 10);
        if (Number.isFinite(button) && Number.isFinite(x) && Number.isFinite(y)) {
          events.push({
            button,
            x,
            y,
            kind: suffix === "m" ? "release" : (button & 32) !== 0 ? "drag" : "press",
          });
        }
      }
      return "";
    },
  );
  return { input, scrollDelta, horizontalScrollDelta, events };
}

export function codeCopyTargetAt(
  targets: CodeCopyTarget[],
  point: ScreenPoint,
): CodeCopyTarget | undefined {
  return targets.find(
    (target) => target.y === point.y && point.x >= target.xStart && point.x <= target.xEnd,
  );
}

export function escapeStopsActiveTurn(state: AppState): boolean {
  if (state.overlay || state.creatingTopic) return false;
  const topic = activeTopic(state);
  return Boolean(topic && state.activity[topic.id]?.running);
}

export function ctrlCExitsTopicPicker(state: AppState): boolean {
  return state.overlay === "topics";
}

/**
 * Text a key chunk contributes to the topic picker's filter query, or `null`
 * when the chunk is a command rather than typing.
 *
 * Split out of `TerminalApp` so the "is this filter input?" decision is unit
 * testable, matching how `ctrlCExitsTopicPicker` and friends are handled.
 *
 * Rejects C0 control bytes (every `Ctrl-` chord, Enter, Tab), DEL, and anything
 * containing ESC (arrow keys, `[3~`, mouse reports, bracketed-paste markers) —
 * those are all routed to real actions before this is consulted, and letting a
 * stray escape sequence through would splatter `[A` into the query. Everything
 * else, including Hangul jamo and completed syllables, is literal text.
 */
export function topicFilterInsertion(chunk: string): string | null {
  if (chunk.length === 0) return null;
  for (const character of chunk) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return chunk;
}

/**
 * A paste, reshaped for the single-line topic filter.
 *
 * Same sanitising as the composer, then newlines become spaces: the filter is a
 * one-line substring match, so keeping only the first line would silently drop
 * text the user pasted, while a space is a character the match already handles.
 */
export function topicFilterPasteText(payload: string): string {
  return sanitizePastedText(payload).replaceAll("\n", " ");
}
