import { expect, test } from "bun:test";
import { altScreenSequences, kittyKeyboardEnabled } from "@/app";
import {
  consumeMouseInput,
  normalizeKeySequences,
  PASTED_TAB_WIDTH,
  sanitizePastedText,
  splitBracketedPaste,
  terminalNewlineShortcut,
} from "@/app-helpers";

const ESC = "\u001b";
/**
 * A fixed environment for every alt-screen assertion.
 *
 * The exported `ENTER`/`EXIT` constants are computed from
 * the *ambient* environment at module load, so asserting fixed colour bytes
 * against them made the suite fail under `NO_COLOR=1` or `TERM=dumb` — a real
 * configuration, not a hypothetical one. Every test here passes its own env in.
 */
const TRUECOLOR_ENV: NodeJS.ProcessEnv = { TERM: "xterm-256color", COLORTERM: "truecolor" };
const { enter: ENTER, exit: EXIT } = altScreenSequences(TRUECOLOR_ENV);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Mirrors how `TerminalApp.#handleInput` composes the input helpers. */
function pipeline(raw: string, pasting = false) {
  const split = splitBracketedPaste(raw, pasting);
  let payload = "";
  let keys = "";
  let events = 0;
  let scrollDelta = 0;
  for (const segment of split.segments) {
    if (segment.kind === "keys") {
      const mouse = consumeMouseInput(segment.text);
      events += mouse.events.length;
      scrollDelta += mouse.scrollDelta;
      keys += mouse.input;
      continue;
    }
    payload += segment.text;
  }
  return {
    pasted: sanitizePastedText(payload),
    keys,
    events,
    scrollDelta,
    pasting: split.pasting,
  };
}

test("keeps pasted bytes away from the mouse parser instead of replaying phantom clicks", () => {
  // Regression: the SGR mouse regex used to run on the whole raw stdin chunk, so
  // an escape sequence inside a bracketed paste was swallowed there *and*
  // dispatched as a real button press.
  const withEscape = pipeline(`${PASTE_START}line1${ESC}[<0;10;5Mline3${PASTE_END}`);
  expect(withEscape.pasted).toBe("line1line3");
  expect(withEscape.events).toBe(0);
  expect(withEscape.scrollDelta).toBe(0);

  // A wheel report inside the payload no longer scrolls the conversation.
  const withWheel = pipeline(`${PASTE_START}top${ESC}[<64;1;1Mbottom${PASTE_END}`);
  expect(withWheel.pasted).toBe("topbottom");
  expect(withWheel.scrollDelta).toBe(0);

  // Text that only looks like a mouse report survives byte for byte.
  expect(pipeline(`${PASTE_START}line1[<0;10;5Mline3${PASTE_END}`).pasted).toBe(
    "line1[<0;10;5Mline3",
  );

  // Real mouse reports outside a paste still parse.
  const realClick = pipeline(`${ESC}[<0;3;4M`);
  expect(realClick.events).toBe(1);
  expect(realClick.keys).toBe("");
});

test("splits bracketed pastes across stdin chunks without leaking markers", () => {
  const first = splitBracketedPaste(`abc${PASTE_START}one`, false);
  expect(first.pasting).toBe(true);
  expect(first.segments).toEqual([
    { kind: "keys", text: "abc" },
    { kind: "paste-chunk", text: "one" },
  ]);

  const second = splitBracketedPaste(`two${PASTE_END}\r`, true);
  expect(second.pasting).toBe(false);
  expect(second.segments).toEqual([
    { kind: "paste-end", text: "two" },
    { kind: "keys", text: "\r" },
  ]);

  // Two pastes in one chunk stay separate payloads.
  expect(
    splitBracketedPaste(`${PASTE_START}a${PASTE_END}${PASTE_START}b${PASTE_END}`, false).segments,
  ).toEqual([
    { kind: "paste-end", text: "a" },
    { kind: "paste-end", text: "b" },
  ]);

  // An empty paste still commits so the composer render stays in sync.
  expect(splitBracketedPaste(`${PASTE_START}${PASTE_END}`, false).segments).toEqual([
    { kind: "paste-end", text: "" },
  ]);
});

test("sanitizes pasted control bytes while preserving every printable character", () => {
  expect(sanitizePastedText(`echo ${ESC}[31mred${ESC}[0m`)).toBe("echo red");
  expect(sanitizePastedText(`a${ESC}]0;title\u0007b`)).toBe("ab");
  expect(sanitizePastedText(`a${ESC}P1$r0m${ESC}\\b`)).toBe("ab");
  expect(sanitizePastedText(`a${ESC}OAb`)).toBe("ab");
  expect(sanitizePastedText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  expect(sanitizePastedText("\ttab")).toBe(`${" ".repeat(PASTED_TAB_WIDTH)}tab`);
  expect(sanitizePastedText("bell\u0007null\u0000del\u007f")).toBe("bellnulldel");
  // Korean, emoji and full-width text are never touched.
  expect(sanitizePastedText("한글 😀 ￦ ok")).toBe("한글 😀 ￦ ok");
  // A bare `ESC ]` with no terminator must not eat the rest of the payload.
  expect(sanitizePastedText(`keep${ESC}]this`)).toBe("keep]this");
});

test("asserts the same DECCKM state on entering and leaving the alt screen", () => {
  // `[?1l` keeps arrow keys in CSI form. `?1049h` does not save the mode, so the
  // exit sequence re-asserts the identical reset rather than guessing a previous
  // value the terminal never told us.
  expect(ENTER).toContain(`${ESC}[?1l`);
  expect(EXIT).toContain(`${ESC}[?1l`);
  // Never restore application cursor key mode on the way out.
  expect(EXIT).not.toContain(`${ESC}[?1h`);
  // XTRESTORE is deliberately avoided: a terminal without it can read
  // `CSI ? 1 r` as DECSTBM and clobber the scroll region.
  expect(ENTER).not.toContain(`${ESC}[?1s`);
  expect(EXIT).not.toContain(`${ESC}[?1r`);
});

test("normalizes SS3 cursor keys sent in application cursor key mode", () => {
  for (const final of ["A", "B", "C", "D", "H", "F"]) {
    expect(normalizeKeySequences(`${ESC}O${final}`)).toBe(`${ESC}[${final}`);
  }
  // CSI forms and ordinary text are untouched.
  expect(normalizeKeySequences(`${ESC}[A`)).toBe(`${ESC}[A`);
  expect(normalizeKeySequences("Oh 한글")).toBe("Oh 한글");
});

test("accepts Shift-Enter and Ctrl-Enter as newline keys across terminal protocols", () => {
  for (const chunk of [
    `${ESC}\r`,
    `${ESC}\n`,
    "\n",
    `${ESC}[13;2u`,
    `${ESC}[13;3u`,
    `${ESC}[13;5u`,
    `${ESC}[13;6u`,
    `${ESC}[27;2;13~`,
    `${ESC}[27;5;13~`,
  ]) {
    expect(terminalNewlineShortcut(chunk)).toBe(true);
  }
  // Plain Enter still submits, and the Hangul jamo shortcuts stay unaffected.
  expect(terminalNewlineShortcut("\r")).toBe(false);
  expect(terminalNewlineShortcut(`${ESC}[13u`)).toBe(false);
  expect(terminalNewlineShortcut("ㅜ")).toBe(false);
  expect(terminalNewlineShortcut("n")).toBe(false);
});

test("bounds SGR mouse coordinates so a pasted digit run is never consumed", () => {
  const overlong = `${ESC}[<0;10;5555555555555555M`;
  expect(consumeMouseInput(overlong)).toEqual({
    input: overlong,
    scrollDelta: 0,
    horizontalScrollDelta: 0,
    events: [],
  });
});

/** The C0 byte a legacy terminal emits for Ctrl plus an ASCII letter. */
function ctrl(letter: string): string {
  return String.fromCharCode((letter.codePointAt(0) as number) - 96);
}
const NUL = String.fromCharCode(0);
const BS = String.fromCharCode(8);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const DEL = String.fromCharCode(127);

test("pairs every mode the enter sequence sets with a reset in the exit sequence", () => {
  // `?<n>h` / `?<n>l` are the private modes we own. Anything switched on has to
  // be switched off again, or the parent shell inherits it.
  const enabled = [...ENTER.matchAll(/\[\?(\d+)h/g)].map((match) => match[1]);
  expect(enabled).toEqual(["1049", "2004", "1002", "1006"]);
  for (const mode of enabled) {
    expect(EXIT).toContain(`${ESC}[?${mode}l`);
  }
  // The alt screen is the last thing released, after the modes that live inside it.
  for (const mode of ["1006", "1002", "2004", "25"]) {
    expect(EXIT.indexOf(`${ESC}[?${mode}`)).toBeLessThan(EXIT.indexOf(`${ESC}[?1049l`));
  }
  // The forced background colour is undone by OSC 111, the hidden cursor by `?25h`.
  expect(ENTER).toContain(`${ESC}]11;`);
  expect(EXIT).toContain(`${ESC}]111`);
  expect(ENTER).toContain(`${ESC}[?25l`);
  expect(EXIT).toContain(`${ESC}[?25h`);
});

test("pushes exactly one kitty keyboard flag and pops it first on the way out", () => {
  // Flag 1 (DISAMBIGUATE_ESCAPE_CODES) only. Flag 2 (REPORT_EVENT_TYPES) is what
  // forces per-terminal exception tables, and we have no use for key releases.
  expect(ENTER).toEndWith(`${ESC}[>1u`);
  for (const flags of [3, 5, 7, 9, 15]) {
    expect(ENTER).not.toContain(`${ESC}[>${flags}u`);
  }
  // Synchronized output is ended first (an unconditional, idempotent unfreeze),
  // then the keyboard is handed back before anything else — so even a truncated
  // exit leaves a usable terminal.
  expect(EXIT).toStartWith(`${ESC}[?2026l${ESC}[<u`);
});

test("drops both halves of the kitty handshake when the escape hatch is set", () => {
  const disabled = altScreenSequences({
    ...TRUECOLOR_ENV,
    NEGOTIUM_TUI_DISABLE_KITTY_KEYBOARD: "1",
  });
  expect(disabled.enter).not.toContain(`${ESC}[>1u`);
  // Never pop without pushing: that would clobber a stack entry an outer app owns.
  expect(disabled.exit).not.toContain(`${ESC}[<u`);
  expect(kittyKeyboardEnabled({ NEGOTIUM_TUI_DISABLE_KITTY_KEYBOARD: "1" })).toBe(false);
  expect(kittyKeyboardEnabled({})).toBe(true);
  // Everything else is untouched by the escape hatch.
  expect(disabled.enter).toBe(ENTER.replace(`${ESC}[>1u`, ""));
  expect(disabled.exit).toBe(EXIT.replace(`${ESC}[<u`, ""));
});

test("turns kitty CSI-u key reports back into the legacy bytes the app dispatches on", () => {
  // Escape. This is the one that would otherwise kill every cancel/close path:
  // with DISAMBIGUATE_ESCAPE_CODES a bare Esc arrives as `CSI 27 u`.
  expect(normalizeKeySequences(`${ESC}[27u`)).toBe(ESC);
  expect(normalizeKeySequences(`${ESC}[27;1u`)).toBe(ESC);
  // Ctrl chords stop being C0 bytes under the protocol; negotium binds ~14 of them.
  expect(normalizeKeySequences(`${ESC}[99;5u`)).toBe(ctrl("c"));
  expect(normalizeKeySequences(`${ESC}[120;5u`)).toBe(ctrl("x"));
  expect(normalizeKeySequences(`${ESC}[117;5u`)).toBe(ctrl("u"));
  expect(normalizeKeySequences(`${ESC}[111;5u`)).toBe(ctrl("o"));
  expect(normalizeKeySequences(`${ESC}[32;5u`)).toBe(NUL); // Ctrl-Space
  // Alt chords: ESC prefix plus the unmodified key, exactly the legacy form.
  expect(normalizeKeySequences(`${ESC}[98;3u`)).toBe(`${ESC}b`);
  expect(normalizeKeySequences(`${ESC}[102;3u`)).toBe(`${ESC}f`);
  expect(normalizeKeySequences(`${ESC}[98;7u`)).toBe(`${ESC}${ctrl("b")}`); // Ctrl-Alt-b
  expect(normalizeKeySequences(`${ESC}[98;4u`)).toBe(`${ESC}B`); // Shift-Alt-b
  // Enter/Tab/Backspace keep their legacy bytes when unmodified (kitty spec:
  // "The only exceptions are the Enter, Tab and Backspace keys which still
  // generate the same bytes as in legacy mode"), so these only reach us at all
  // once a modifier is involved.
  expect(normalizeKeySequences(`${ESC}[13u`)).toBe(CR);
  expect(normalizeKeySequences(`${ESC}[9u`)).toBe(TAB);
  expect(normalizeKeySequences(`${ESC}[127u`)).toBe(DEL);
  expect(normalizeKeySequences(`${ESC}[127;5u`)).toBe(BS); // Ctrl-Backspace
  expect(normalizeKeySequences(`${ESC}[127;3u`)).toBe(`${ESC}${DEL}`); // Alt-Backspace
  expect(normalizeKeySequences(`${ESC}[9;2u`)).toBe(`${ESC}[Z`); // Shift-Tab
  expect(normalizeKeySequences(`${ESC}[13;3u`)).toBe(`${ESC}${CR}`); // Alt-Enter
});

test("keeps Shift-Enter and Ctrl-Enter distinguishable instead of collapsing them", () => {
  // Collapsing these to CR would throw away the only thing the protocol buys us.
  expect(normalizeKeySequences(`${ESC}[13;2u`)).toBe(`${ESC}[13;2u`);
  expect(normalizeKeySequences(`${ESC}[13;5u`)).toBe(`${ESC}[13;5u`);
  expect(terminalNewlineShortcut(normalizeKeySequences(`${ESC}[13;2u`))).toBe(true);
  expect(terminalNewlineShortcut(normalizeKeySequences(`${ESC}[13;5u`))).toBe(true);
});

test("ignores caps lock and num lock, which the protocol stops masking", () => {
  // kitty only strips the lock bits while no keyboard flag is pushed
  // (key_encoding.c `convert_glfw_mods`), so with flag 1 on, Caps Lock inflates
  // every modifier field and would otherwise silently break every shortcut.
  expect(normalizeKeySequences(`${ESC}[99;69u`)).toBe(ctrl("c")); // Ctrl-C, caps lock on
  expect(normalizeKeySequences(`${ESC}[27;65u`)).toBe(ESC); // Esc, caps lock on
  expect(normalizeKeySequences(`${ESC}[1;65A`)).toBe(`${ESC}[A`); // Up, caps lock on
  expect(normalizeKeySequences(`${ESC}[1;193A`)).toBe(`${ESC}[A`); // Up, both locks on
  expect(normalizeKeySequences(`${ESC}[3;65~`)).toBe(`${ESC}[3~`); // Delete, caps lock on
  expect(normalizeKeySequences(`${ESC}[13;66u`)).toBe(`${ESC}[13;2u`); // Shift-Enter, caps lock
  // Real modifiers on cursor keys survive untouched.
  expect(normalizeKeySequences(`${ESC}[1;5C`)).toBe(`${ESC}[1;5C`);
  expect(normalizeKeySequences(`${ESC}[1;69D`)).toBe(`${ESC}[1;5D`);
});

test("leaves sequences alone when there is no legacy form to fall back to", () => {
  // Ctrl-Shift and super/hyper/meta have no legacy encoding by spec, so the
  // event is preserved verbatim rather than mangled into the wrong key.
  expect(normalizeKeySequences(`${ESC}[99;6u`)).toBe(`${ESC}[99;6u`);
  expect(normalizeKeySequences(`${ESC}[99;9u`)).toBe(`${ESC}[99;9u`);
  // Functional keys in the private-use range keep their own numbering.
  expect(normalizeKeySequences(`${ESC}[57399u`)).toBe(`${ESC}[57399u`);
  // Ordinary text, mouse reports and paste markers must not be touched.
  expect(normalizeKeySequences("한글 u")).toBe("한글 u");
  expect(normalizeKeySequences(`${ESC}[<0;10;5M`)).toBe(`${ESC}[<0;10;5M`);
  expect(normalizeKeySequences(`${ESC}[200~body${ESC}[201~`)).toBe(`${ESC}[200~body${ESC}[201~`);
  expect(normalizeKeySequences(`${ESC}[3~`)).toBe(`${ESC}[3~`);
});

test("normalizes a whole stdin chunk, not just an isolated sequence", () => {
  // Real terminals coalesce keystrokes, so the rewriter has to be global.
  expect(normalizeKeySequences(`${ESC}[27u${ESC}[99;5uhi${ESC}OA`)).toBe(
    `${ESC}${ctrl("c")}hi${ESC}[A`,
  );
});

/**
 * Feeds `chunks` through the splitter the way `TerminalApp.#handleInput` does.
 *
 * Each `keys` segment is normalized on its own, exactly as `#handleKeySegment`
 * does — that is what makes a torn sequence observable here. Concatenating the
 * raw segments first would hide the bug, because the *bytes* are the same
 * either way; what differs is that a split sequence reaches the dispatcher as
 * two unrecognisable halves.
 */
function stream(chunks: string[]): {
  keys: string;
  pastes: string[];
  pasting: boolean;
  carry: string;
} {
  let pasting = false;
  let carry = "";
  let keys = "";
  let payload = "";
  const pastes: string[] = [];
  for (const chunk of chunks) {
    const split = splitBracketedPaste(chunk, pasting, carry);
    pasting = split.pasting;
    carry = split.carry;
    for (const segment of split.segments) {
      if (segment.kind === "keys") keys += normalizeKeySequences(segment.text);
      else if (segment.kind === "paste-chunk") payload += segment.text;
      else {
        pastes.push(payload + segment.text);
        payload = "";
      }
    }
  }
  return { keys, pastes, pasting, carry };
}

test("recovers a paste marker torn across a chunk boundary at every byte", () => {
  // A marker is six bytes; a large paste is split by the stdin buffer wherever
  // it lands. Before the carry buffer a torn *end* marker left the parser stuck
  // in paste mode for good — every later keystroke vanished into the payload.
  for (let cut = 1; cut <= 5; cut += 1) {
    const torn = stream([
      `${PASTE_START}hello${PASTE_END.slice(0, cut)}`,
      `${PASTE_END.slice(cut)}after`,
    ]);
    expect(torn).toEqual({ keys: "after", pastes: ["hello"], pasting: false, carry: "" });

    // A torn *start* marker used to fall through to the key parser, which put
    // the payload back on the path that sanitising exists to protect.
    const opening = stream([
      PASTE_START.slice(0, cut),
      `${PASTE_START.slice(cut)}body${PASTE_END}`,
    ]);
    expect(opening).toEqual({ keys: "", pastes: ["body"], pasting: false, carry: "" });

    // Split at both ends at once, one byte per chunk in the middle.
    const both = stream([
      PASTE_START.slice(0, cut),
      `${PASTE_START.slice(cut)}a`,
      `b${PASTE_END.slice(0, cut)}`,
      PASTE_END.slice(cut),
    ]);
    expect(both).toEqual({ keys: "", pastes: ["ab"], pasting: false, carry: "" });
  }
});

test("releases a held fragment that turns out not to be a paste marker", () => {
  // `ESC [ 2 0` is a prefix of the start marker right up until the next byte
  // says otherwise. Those bytes must reach the key parser, not disappear.
  for (let cut = 1; cut <= 5; cut += 1) {
    const fake = `${PASTE_START.slice(0, cut)}Z`;
    expect(stream([PASTE_START.slice(0, cut), "Z"])).toEqual({
      keys: fake,
      pastes: [],
      pasting: false,
      carry: "",
    });
  }
  // Same inside a paste: the payload keeps the bytes verbatim.
  expect(stream([`${PASTE_START}a${PASTE_END.slice(0, 4)}`, `Z${PASTE_END}`])).toEqual({
    keys: "",
    pastes: [`a${PASTE_END.slice(0, 4)}Z`],
    pasting: false,
    carry: "",
  });
});

test("holds back an unfinished escape sequence, and nothing else", () => {
  // A *complete* sequence is never held: it is ready to dispatch as it stands.
  for (const chunk of [
    `${ESC}[A`,
    `${ESC}[3~`,
    `${ESC}[99;5u`,
    `${ESC}OA`,
    `${ESC}[<0;3;4M`,
    `${ESC}[200~`,
    `${ESC}b`, // Alt-b: the two-byte form is complete
    "한글",
  ]) {
    expect(splitBracketedPaste(chunk, false).carry).toBe("");
  }
  // An unfinished one is held in full, whatever kind it is.
  for (const partial of [
    `${ESC}[`,
    `${ESC}[9`,
    `${ESC}[99;`,
    `${ESC}[<0;3;`,
    `${ESC}O`,
    `${ESC}[200`,
  ]) {
    expect(splitBracketedPaste(partial, false).carry).toBe(partial);
    expect(splitBracketedPaste(partial, false).segments).toEqual([]);
  }
  // Text in front of the fragment is dispatched immediately.
  expect(splitBracketedPaste(`hi${ESC}[99;`, false)).toEqual({
    segments: [{ kind: "keys", text: "hi" }],
    pasting: false,
    carry: `${ESC}[99;`,
  });
  // A lone ESC cannot be told apart from the start of a longer sequence, which
  // is why the app flushes the carry on an idle timer instead of waiting for a
  // byte that may never come.
  expect(splitBracketedPaste(ESC, false).carry).toBe(ESC);
});

test("parses a sequence the same way no matter where the chunk boundary falls", () => {
  // stdin splits wherever the read buffer ends. Since the kitty keyboard
  // protocol went in, Ctrl-C is the seven bytes `ESC [ 9 9 ; 5 u`, so a split
  // inside it used to lose the chord *and* type `5u` into the composer.
  const sequences = [
    `${ESC}[99;5u`, // kitty Ctrl-C
    `${ESC}[27u`, // kitty Esc
    `${ESC}[13;2u`, // kitty Shift-Enter
    `${ESC}[A`, // cursor up
    `${ESC}OA`, // SS3 cursor up
    `${ESC}[3~`, // Delete
    `${ESC}[<0;10;5M`, // SGR mouse
    PASTE_START,
    PASTE_END,
  ];
  for (const sequence of sequences) {
    const whole = stream([sequence]);
    for (let cut = 1; cut < sequence.length; cut += 1) {
      const label = `${JSON.stringify(sequence)} cut@${cut}`;
      const split = stream([sequence.slice(0, cut), sequence.slice(cut)]);
      expect(split, label).toEqual(whole);
      expect(split.carry, label).toBe("");
    }
  }
});

test("passes through bytes that only looked like the start of a sequence", () => {
  // `q` is a valid CSI final byte, so this is a complete (if unbound) sequence
  // and must arrive whole rather than being dropped or split in two.
  expect(stream([`${ESC}[99;`, "q"]).keys).toBe(`${ESC}[99;q`);
  // A byte that cannot appear in a CSI at all ends the scan immediately.
  expect(splitBracketedPaste(`${ESC}[9\u0007`, false).carry).toBe("");
  // The carry is bounded: an escape sequence that never finishes is eventually
  // released to the key parser instead of swallowing the stream.
  const runaway = `${ESC}[${"9".repeat(64)}`;
  expect(splitBracketedPaste(runaway, false).carry).toBe("");
  expect(splitBracketedPaste(runaway, false).segments).toEqual([{ kind: "keys", text: runaway }]);
});
