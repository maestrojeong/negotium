import { expect, test } from "bun:test";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from "@/app";
import { placeTerminalCursor, TerminalScreenRenderer } from "@/screen-renderer";

const CLEAR_DISPLAY = "\u001b[2J";

test("fills the alternate screen with the terminal canvas color on entry", () => {
  expect(ENTER_ALT_SCREEN).toStartWith("\u001b]11;#0a0b0f\u0007");
  expect(ENTER_ALT_SCREEN).toContain("\u001b[48;2;10;11;15m\u001b[2J\u001b[H");
});

test("restores terminal autowrap when leaving the alternate screen", () => {
  expect(EXIT_ALT_SCREEN).toContain("\u001b[?7h");
  expect(EXIT_ALT_SCREEN.indexOf("\u001b[?7h")).toBeLessThan(
    EXIT_ALT_SCREEN.indexOf("\u001b[?1049l"),
  );
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
