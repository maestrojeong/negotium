import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { patchCodexSdkSource } from "../bin/codex-sdk-window-hide.mjs";

describe("Codex SDK window hide patch", () => {
  const sdkPath = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
  const source = readFileSync(sdkPath, "utf8");

  test("adds windowsHide to the SDK's codex spawn call", () => {
    const patched = patchCodexSdkSource(source);
    expect(patched).toBeDefined();
    expect(patched).toMatch(
      /spawn\(this\.executablePath, commandArgs, \{\s*env,\s*windowsHide: true,/,
    );
    // Only that call is touched.
    expect(patched?.length).toBe(source.length + " windowsHide: true,".length);
  });

  test("is idempotent", () => {
    const once = patchCodexSdkSource(source);
    expect(once).toBeDefined();
    expect(patchCodexSdkSource(once as string)).toBeUndefined();
  });

  test("leaves an SDK with a different call shape untouched", () => {
    expect(patchCodexSdkSource("const child = spawn(other, args, {});")).toBeUndefined();
  });
});
