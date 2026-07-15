import { expect, test } from "bun:test";
import { ENTER_ALT_SCREEN } from "@/app";
import { placeTerminalCursor, TerminalScreenRenderer } from "@/screen-renderer";

const CLEAR_DISPLAY = "\u001b[2J";

test("fills the alternate screen with the terminal canvas color on entry", () => {
  expect(ENTER_ALT_SCREEN).toStartWith("\u001b]11;#0a0b0f\u0007");
  expect(ENTER_ALT_SCREEN).toContain("\u001b[48;2;10;11;15m\u001b[2J\u001b[H");
});

test("places and shows the hardware cursor for IME composition", () => {
  expect(placeTerminalCursor({ x: 7, y: 12 })).toBe("\u001b[12;7H\u001b[?25h");
});

test("draws the initial frame without clearing the whole display", () => {
  const renderer = new TerminalScreenRenderer();
  const output = renderer.update("first\nsecond");

  expect(output).toContain("\u001b[1;1H\u001b[2Kfirst");
  expect(output).toContain("\u001b[2;1H\u001b[2Ksecond");
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

test("clears stale rows and can invalidate a resized frame", () => {
  const renderer = new TerminalScreenRenderer();
  renderer.update("first\nsecond");

  expect(renderer.update("first")).toContain("\u001b[2;1H\u001b[2K");
  renderer.invalidate();
  const output = renderer.update("first");
  expect(output).toContain("\u001b[1;1H\u001b[2Kfirst");
  expect(output).not.toContain(CLEAR_DISPLAY);
});
