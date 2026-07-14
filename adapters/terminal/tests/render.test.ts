import { describe, expect, test } from "bun:test";
import { displayWidth, renderApp, stripAnsi, wrapText } from "@/render";
import { createInitialState } from "@/state";

describe("terminal renderer", () => {
  test("counts Korean glyphs as wide characters", () => {
    expect(displayWidth("a한")).toBe(3);
    expect(wrapText("가나다", 4)).toEqual(["가나", "다"]);
  });

  test("fills exactly the requested terminal height", () => {
    const output = renderApp(createInitialState("local"), 120, 30);
    expect(output.split("\n")).toHaveLength(30);
  });

  test("strips terminal escape sequences", () => {
    expect(stripAnsi("safe\u001b[2Jbad")).toBe("safebad");
  });
});
