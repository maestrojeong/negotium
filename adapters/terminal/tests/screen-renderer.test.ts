import { expect, test } from "bun:test";
import { altScreenSequences } from "@/app";
import {
  BEGIN_SYNCHRONIZED_UPDATE,
  END_SYNCHRONIZED_UPDATE,
  placeTerminalCursor,
  TerminalScreenRenderer,
} from "@/screen-renderer";

const CLEAR_DISPLAY = "\u001b[2J";
// Explicit env: the exported constants are derived from the ambient one, so
// asserting fixed colour bytes against them fails under `NO_COLOR`/`TERM=dumb`.
const { enter: ENTER, exit: EXIT } = altScreenSequences({
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
});

test("fills the alternate screen with the terminal canvas color on entry", () => {
  expect(ENTER).toStartWith("\u001b]11;#0a0b0f\u0007");
  expect(ENTER).toContain("\u001b[48;2;10;11;15m\u001b[2J\u001b[H");
});

test("restores terminal autowrap when leaving the alternate screen", () => {
  expect(EXIT).toContain("\u001b[?7h");
  // Every patch opens with `CSI ?2026h`; dying between begin and end would
  // otherwise leave the terminal buffering its output even after the restore.
  expect(EXIT).toStartWith(END_SYNCHRONIZED_UPDATE);
  expect(EXIT.indexOf("\u001b[?7h")).toBeLessThan(EXIT.indexOf("\u001b[?1049l"));
});

test("places and shows the hardware cursor for IME composition", () => {
  expect(placeTerminalCursor({ x: 7, y: 12 })).toBe("\u001b[12;7H\u001b[?25h");
});

test("draws the initial frame without clearing the whole display", () => {
  const renderer = new TerminalScreenRenderer();
  const output = renderer.update("first\nsecond");

  expect(output).toContain("\u001b[1;1H\u001b[2Kfirst");
  expect(output).toContain("\u001b[2;1H\u001b[2K\u001b[?7lsecond\u001b[?7h");
  expect(output).not.toContain(CLEAR_DISPLAY);
});

test("emits nothing when the frame has not changed", () => {
  const renderer = new TerminalScreenRenderer();
  renderer.update("first\nsecond");

  expect(renderer.update("first\nsecond")).toBe("");
});

test("updates only changed rows", () => {
  const renderer = new TerminalScreenRenderer();
  renderer.update("first\nsecond\nthird");

  const output = renderer.update("first\nchanged\nthird");
  expect(output).toContain("\u001b[2;1H\u001b[2Kchanged");
  expect(output).not.toContain("\u001b[1;1H");
  expect(output).not.toContain("\u001b[3;1H");
  expect(output).not.toContain(CLEAR_DISPLAY);
});

test("renders an exact-width final physical row without leaving autowrap pending", () => {
  const renderer = new TerminalScreenRenderer();
  const output = renderer.update("abcd\nWXYZ", 2);

  expect(output).toContain("\u001b[2;1H\u001b[2K\u001b[?7lWXYZ\u001b[?7h");
  expect(output.indexOf("\u001b[?7h")).toBeLessThan(output.lastIndexOf("\u001b[H"));
});

test("preserves wide characters on the protected final physical row", () => {
  const renderer = new TerminalScreenRenderer();
  const output = renderer.update("first\n가나다", 2);

  expect(output).toContain("\u001b[?7l가나다\u001b[?7h");
});

test("restores autowrap before positioning and showing the hardware cursor", () => {
  const renderer = new TerminalScreenRenderer();
  const output = renderer.update("1234\n5678", 2) + placeTerminalCursor({ x: 4, y: 2 });

  expect(output).toEndWith("\u001b[2;4H\u001b[?25h");
  expect(output.indexOf("\u001b[?7h")).toBeLessThan(output.indexOf("\u001b[2;4H"));
});

test("clears stale rows and can invalidate a resized frame", () => {
  const renderer = new TerminalScreenRenderer();
  renderer.update("first\nsecond");

  expect(renderer.update("first")).toContain("\u001b[2;1H\u001b[2K");
  renderer.invalidate();
  const output = renderer.update("first");
  expect(output).toContain("\u001b[1;1H\u001b[2K\u001b[?7lfirst\u001b[?7h");
  expect(output).not.toContain(CLEAR_DISPLAY);
});

test("clears a stale final row without printable output", () => {
  const renderer = new TerminalScreenRenderer();
  renderer.update("first\nsecond", 2);

  const output = renderer.update("first", 2);
  expect(output).toContain("\u001b[2;1H\u001b[2K\u001b[?7l\u001b[?7h");
  expect(output).not.toContain("second");
});

test("does not address rows below the resized physical screen", () => {
  const renderer = new TerminalScreenRenderer();
  renderer.update("first\nsecond\nthird", 3);
  renderer.invalidate();

  const output = renderer.update("first\nsecond", 2);
  expect(output).not.toContain("\u001b[3;1H");
  expect(output).toContain("\u001b[2;1H\u001b[2K\u001b[?7lsecond\u001b[?7h");
});

test("wraps every patch in a DECSET 2026 synchronized update", () => {
  const renderer = new TerminalScreenRenderer();

  const first = renderer.update("first\nsecond");
  expect(BEGIN_SYNCHRONIZED_UPDATE).toBe("\u001b[?2026h");
  expect(END_SYNCHRONIZED_UPDATE).toBe("\u001b[?2026l");
  expect(first).toStartWith(BEGIN_SYNCHRONIZED_UPDATE);
  expect(first).toEndWith(END_SYNCHRONIZED_UPDATE);
  // Every row move must be inside the synchronized block, not around it.
  expect(first.indexOf("\u001b[1;1H")).toBeGreaterThan(0);
  expect(first.lastIndexOf("\u001b[H")).toBeLessThan(first.lastIndexOf(END_SYNCHRONIZED_UPDATE));
  expect(first.split(BEGIN_SYNCHRONIZED_UPDATE)).toHaveLength(2);
  expect(first.split(END_SYNCHRONIZED_UPDATE)).toHaveLength(2);
});

test("emits no synchronized-update markers when nothing changed", () => {
  const renderer = new TerminalScreenRenderer();
  renderer.update("first\nsecond");

  const unchanged = renderer.update("first\nsecond");
  expect(unchanged).toBe("");
  expect(unchanged).not.toContain(BEGIN_SYNCHRONIZED_UPDATE);
});

test("keeps the autowrap guard inside the synchronized block", () => {
  const renderer = new TerminalScreenRenderer();
  const output = renderer.update("1234\n5678", 2);

  expect(output.indexOf("\u001b[?7l")).toBeGreaterThan(output.indexOf(BEGIN_SYNCHRONIZED_UPDATE));
  expect(output.indexOf("\u001b[?7h")).toBeLessThan(output.indexOf(END_SYNCHRONIZED_UPDATE));
});
