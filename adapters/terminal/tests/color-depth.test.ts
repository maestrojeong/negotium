import { afterEach, describe, expect, test } from "bun:test";
import type { MessageDto, TopicDto } from "@negotium/core";
import { altScreenSequences } from "@/app";
import { type ColorDepth, detectColorDepth, rgbToAnsi16, rgbToAnsi256 } from "@/color-depth";
import { displayWidth, getColorDepth, renderApp, setColorDepth } from "@/render";
import { createInitialState, selectTopic, setTopics, upsertMessage } from "@/state";

const ESC = "\u001b";

function topic(): TopicDto {
  return {
    id: "topic",
    title: "Terminal",
    kind: "public",
    agent: "codex",
    defaultModel: "gpt",
    defaultEffort: "medium",
  } as unknown as TopicDto;
}

function message(text: string): MessageDto {
  return {
    id: "m1",
    topicId: "topic",
    authorId: "ai",
    authorName: "AI",
    text,
    createdAt: 1,
  } as unknown as MessageDto;
}

function sampleState() {
  let state = createInitialState("me");
  state = setTopics(state, [topic()]);
  state = selectTopic(state, "topic");
  state = upsertMessage(state, message("**bold** and `code` and plain"));
  return state;
}

describe("detectColorDepth", () => {
  const cases: [string, { env: NodeJS.ProcessEnv; isTty: boolean }, ColorDepth][] = [
    ["pipe with no hints", { env: {}, isTty: false }, "none"],
    ["bare tty", { env: {}, isTty: true }, "ansi16"],
    ["TERM=xterm-256color tty", { env: { TERM: "xterm-256color" }, isTty: true }, "ansi256"],
    [
      "COLORTERM=truecolor tty",
      { env: { TERM: "xterm-256color", COLORTERM: "truecolor" }, isTty: true },
      "truecolor",
    ],
    ["COLORTERM=24bit tty", { env: { COLORTERM: "24bit" }, isTty: true }, "truecolor"],
    ["TERM=xterm-direct tty", { env: { TERM: "xterm-direct" }, isTty: true }, "truecolor"],
    ["TERM=dumb tty", { env: { TERM: "dumb" }, isTty: true }, "none"],
    [
      "TERM=dumb outranks COLORTERM",
      { env: { TERM: "dumb", COLORTERM: "truecolor" }, isTty: true },
      "none",
    ],
    [
      "NO_COLOR on a truecolor tty",
      { env: { NO_COLOR: "1", COLORTERM: "truecolor" }, isTty: true },
      "none",
    ],
    ["NO_COLOR with any value", { env: { NO_COLOR: "0" }, isTty: true }, "none"],
    ["NO_COLOR empty is treated as unset", { env: { NO_COLOR: "" }, isTty: true }, "ansi16"],
    [
      "NO_COLOR outranks FORCE_COLOR",
      { env: { NO_COLOR: "1", FORCE_COLOR: "3" }, isTty: true },
      "none",
    ],
    [
      "FORCE_COLOR=0 on a tty",
      { env: { FORCE_COLOR: "0", COLORTERM: "truecolor" }, isTty: true },
      "none",
    ],
    ["FORCE_COLOR=1 over a pipe", { env: { FORCE_COLOR: "1" }, isTty: false }, "ansi16"],
    ["FORCE_COLOR=2 over a pipe", { env: { FORCE_COLOR: "2" }, isTty: false }, "ansi256"],
    ["FORCE_COLOR=3 over a pipe", { env: { FORCE_COLOR: "3" }, isTty: false }, "truecolor"],
    ["FORCE_COLOR bare", { env: { FORCE_COLOR: "" }, isTty: false }, "ansi16"],
    [
      "NEGOTIUM_TUI_COLOR outranks NO_COLOR",
      { env: { NEGOTIUM_TUI_COLOR: "truecolor", NO_COLOR: "1" }, isTty: false },
      "truecolor",
    ],
    [
      "NEGOTIUM_TUI_COLOR=none on a truecolor tty",
      { env: { NEGOTIUM_TUI_COLOR: "none", COLORTERM: "truecolor" }, isTty: true },
      "none",
    ],
    [
      "unknown NEGOTIUM_TUI_COLOR falls through",
      { env: { NEGOTIUM_TUI_COLOR: "rainbow", COLORTERM: "truecolor" }, isTty: true },
      "truecolor",
    ],
  ];

  for (const [name, probe, expected] of cases) {
    test(name, () => {
      expect(detectColorDepth(probe)).toBe(expected);
    });
  }
});

describe("palette downshifts", () => {
  test("maps the theme's near-neutral grays onto distinct 16-colour slots", () => {
    // `muted` vs `subtle` is the pair the original survey flagged as most at
    // risk of collapsing into one colour at low depth.
    expect(rgbToAnsi16([137, 141, 158])).not.toBe(rgbToAnsi16([91, 95, 112]));
  });

  test("keeps hue for tinted accents instead of washing them out to white", () => {
    expect(rgbToAnsi16([245, 116, 128])).toBe(9); // red (salmon)
    expect(rgbToAnsi16([94, 211, 142])).toBe(10); // green (mint)
    expect(rgbToAnsi16([241, 190, 91])).toBe(11); // amber
    expect(rgbToAnsi16([87, 205, 220])).toBe(14); // cyan
    expect(rgbToAnsi16([139, 124, 246])).toBe(12); // accent
  });

  test("keeps dark surfaces dark rather than promoting them to white", () => {
    expect(rgbToAnsi16([10, 11, 15])).toBe(0);
    expect(rgbToAnsi16([48, 52, 67])).toBe(8);
  });

  test("uses the grayscale ramp for neutral triples and the cube otherwise", () => {
    expect(rgbToAnsi256([10, 11, 15])).toBeGreaterThanOrEqual(232);
    expect(rgbToAnsi256([0, 0, 0])).toBe(16);
    expect(rgbToAnsi256([255, 255, 255])).toBe(231);
    expect(rgbToAnsi256([255, 0, 0])).toBe(196);
  });
});

describe("renderer colour depth", () => {
  afterEach(() => {
    setColorDepth("truecolor");
  });

  test("emits no escape bytes at all when colour is off", () => {
    setColorDepth("none");
    expect(getColorDepth()).toBe("none");
    const frame = renderApp(sampleState(), 80, 16);
    expect(frame).not.toContain(ESC);
  });

  test("still distinguishes notice severities by glyph with colour off", () => {
    setColorDepth("none");
    const base = sampleState();
    const rendered = (level: "info" | "success" | "warn" | "error", text: string) =>
      renderApp({ ...base, notice: text, noticeLevel: level }, 80, 16);
    expect(rendered("success", "Copied")).toContain("✓ Copied");
    expect(rendered("error", "Copy failed")).toContain("✗ Copy failed");
    expect(rendered("warn", "Read only")).toContain("! Read only");
    expect(rendered("info", "Turn aborted")).toContain("· Turn aborted");
  });

  test("downshifts to indexed sequences instead of 24-bit ones", () => {
    setColorDepth("ansi256");
    const frame256 = renderApp(sampleState(), 80, 16);
    expect(frame256).toContain(`${ESC}[38;5;`);
    expect(frame256).not.toContain(`${ESC}[38;2;`);

    setColorDepth("ansi16");
    const frame16 = renderApp(sampleState(), 80, 16);
    expect(frame16).not.toContain(`${ESC}[38;5;`);
    expect(frame16).not.toContain(`${ESC}[38;2;`);
    expect(frame16).toMatch(new RegExp(`${ESC}\\[(?:3[0-7]|9[0-7])m`));

    setColorDepth("truecolor");
    expect(renderApp(sampleState(), 80, 16)).toContain(`${ESC}[38;2;`);
  });

  test("emits no escape bytes at all under `none`, hyperlinks included", () => {
    let linked = createInitialState("me");
    linked = setTopics(linked, [topic()]);
    linked = selectTopic(linked, "topic");
    linked = upsertMessage(linked, message("See https://example.com/docs for details."));

    setColorDepth("none");
    const plain = renderApp(linked, 80, 16);
    // `none` is what NO_COLOR and TERM=dumb resolve to: the frame is a promise
    // of plain text, and an OSC 8 hyperlink broke that promise.
    expect(plain).not.toContain(ESC);
    expect(plain).toContain("https://example.com/docs");

    setColorDepth("truecolor");
    expect(renderApp(linked, 80, 16)).toContain(`${ESC}]8;;https://example.com/docs`);
  });

  test("keeps every row exactly as wide as the terminal at every depth", () => {
    for (const depth of ["none", "ansi16", "ansi256", "truecolor"] as const) {
      setColorDepth(depth);
      for (const columns of [10, 20, 32, 44, 120]) {
        for (const row of renderApp(sampleState(), columns, 18).split("\n")) {
          expect(displayWidth(row)).toBeLessThanOrEqual(columns);
        }
      }
    }
  });
});

describe("alt-screen sequences", () => {
  test("repaints the terminal background only when colour is enabled", () => {
    const colored = altScreenSequences({ COLORTERM: "truecolor" });
    expect(colored.enter).toContain(`${ESC}]11;#0a0b0f`);
    expect(colored.enter).toContain(`${ESC}[48;2;10;11;15m`);
    expect(colored.exit).toContain(`${ESC}]111`);
  });

  test("downshifts the canvas fill to the detected depth", () => {
    // The one paint outside the renderer used to be hard-coded 24-bit, so an
    // ansi16 terminal got a sequence it may ignore or misparse.
    expect(altScreenSequences({ TERM: "xterm-256color" }).enter).toContain(`${ESC}[48;5;`);
    expect(altScreenSequences({ TERM: "xterm-256color" }).enter).not.toContain(`${ESC}[48;2;`);
    const ansi16 = altScreenSequences({ TERM: "xterm" }).enter;
    expect(ansi16).not.toContain(`${ESC}[48;5;`);
    expect(ansi16).not.toContain(`${ESC}[48;2;`);
    // theme.canvas is near-black, so the 16-colour downshift is plain black.
    expect(ansi16).toContain(`${ESC}[40m`);
  });

  test("ends synchronized output first on the way out", () => {
    // Render patches open with `CSI ?2026h`; an exit that never closes one can
    // leave the terminal buffering everything printed after the restore.
    for (const env of [{ COLORTERM: "truecolor" }, { NO_COLOR: "1" }, { TERM: "dumb" }]) {
      expect(altScreenSequences(env).exit).toStartWith(`${ESC}[?2026l`);
    }
  });

  test("leaves the user's terminal theme untouched under NO_COLOR", () => {
    const plain = altScreenSequences({ NO_COLOR: "1" });
    expect(plain.enter).not.toContain(`${ESC}]11;`);
    expect(plain.enter).not.toContain(`${ESC}[48;2;`);
    // No OSC 111 either: restoring a background we never set would clobber one
    // the user configured themselves.
    expect(plain.exit).not.toContain(`${ESC}]111`);
    // The rest of the setup is unaffected.
    expect(plain.enter).toContain(`${ESC}[?1049h`);
    expect(plain.exit).toContain(`${ESC}[?1049l`);
  });
});
