import { describe, expect, test } from "bun:test";
import { protectMcpStdio } from "#mcp/factories/stdio-protection";

describe("protectMcpStdio", () => {
  test("redirects log/info and restores caller-owned state", () => {
    const calls: Array<[string, unknown[]]> = [];
    const target = {
      env: {} as Record<string, string | undefined>,
      console: {
        log: (...args: unknown[]) => calls.push(["log", args]),
        info: (...args: unknown[]) => calls.push(["info", args]),
        error: (...args: unknown[]) => calls.push(["error", args]),
      },
    };
    const originalLog = target.console.log;
    const originalInfo = target.console.info;
    const restore = protectMcpStdio(target);

    target.console.log("one");
    target.console.info("two");
    expect(calls).toEqual([
      ["error", ["one"]],
      ["error", ["two"]],
    ]);
    expect(target.env.MAESTRO_SDK_SILENT_BOOTSTRAP).toBe("1");

    restore();
    restore();
    expect(target.console.log).toBe(originalLog);
    expect(target.console.info).toBe(originalInfo);
  });

  test("does not overwrite an explicit SDK bootstrap policy", () => {
    const target = {
      env: { MAESTRO_SDK_SILENT_BOOTSTRAP: "0" },
      console: { log() {}, info() {}, error() {} },
    };
    protectMcpStdio(target)();
    expect(target.env.MAESTRO_SDK_SILENT_BOOTSTRAP).toBe("0");
  });
});
