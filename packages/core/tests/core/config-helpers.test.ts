import { describe, expect, test } from "bun:test";
import {
  parseRuntimePort,
  readEnvText,
  resolveRuntimeStateDir,
  safeRuntimePathSegment,
} from "#platform/config-helpers";

describe("runtime config helpers", () => {
  test("reads caller-owned environment without process globals", () => {
    expect(readEnvText({ PORT: " 7777 " }, "PORT")).toBe("7777");
    expect(readEnvText({ PORT: " " }, "PORT")).toBeUndefined();
  });

  test("validates ports and path segments", () => {
    expect(parseRuntimePort("9700", 1)).toBe(9700);
    expect(parseRuntimePort("70000", 1)).toBe(1);
    expect(safeRuntimePathSegment(" ../topic name ", "topic")).toBe(".._topic_name");
  });

  test("resolves configured and fallback state roots", () => {
    expect(
      resolveRuntimeStateDir({
        env: { STATE: "./custom" },
        envKey: "STATE",
        fallbackRoot: "/tmp",
        fallbackName: "state",
      }),
    ).toEndWith("/custom");
    expect(
      resolveRuntimeStateDir({
        env: {},
        envKey: "STATE",
        fallbackRoot: "/tmp",
        fallbackName: "state",
      }),
    ).toBe("/tmp/state");
  });
});
