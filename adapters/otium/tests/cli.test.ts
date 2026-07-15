import { describe, expect, test } from "bun:test";
import { parseOtiumServePort } from "@/cli";

describe("parseOtiumServePort", () => {
  test("uses the configured default and accepts an explicit port", () => {
    expect(parseOtiumServePort([], 7777)).toBe(7777);
    expect(parseOtiumServePort(["--port", "8123"], 7777)).toBe(8123);
    expect(parseOtiumServePort(["--port=9000"], 7777)).toBe(9000);
  });

  test("rejects ephemeral, invalid, and unrelated arguments", () => {
    expect(() => parseOtiumServePort(["--port", "0"], 7777)).toThrow("between 1 and 65535");
    expect(() => parseOtiumServePort(["--port", "abc"], 7777)).toThrow("between 1 and 65535");
    expect(() => parseOtiumServePort(["extra"], 7777)).toThrow("usage");
    expect(() => parseOtiumServePort(["--unknown"], 7777)).toThrow("usage");
  });
});
