import { describe, expect, test } from "bun:test";
import { parseOtiumServePort, parseOtiumServeRelayUrl } from "@/cli";

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

  test("accepts an explicit relay origin", () => {
    expect(parseOtiumServeRelayUrl(["--port", "8123", "--relay", "wss://relay.example/"])).toBe(
      "wss://relay.example",
    );
    expect(() => parseOtiumServeRelayUrl(["--relay", "ftp://relay.example"])).toThrow(
      "http(s) or ws(s)",
    );
  });
});
