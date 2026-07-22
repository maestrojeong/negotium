import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BROWSER_RS_MIN_SECURE_VERSION,
  BROWSER_RS_VERSION,
  resolveBrowserRsBin,
} from "#platform/config";

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Browser.rs executable resolution", () => {
  test("keeps the tested Browser.rs release pinned", () => {
    expect(BROWSER_RS_VERSION).toBe("v0.1.12");
    expect(BROWSER_RS_MIN_SECURE_VERSION).toBe("0.1.12");
  });

  test("accepts only an executable explicit override", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-rs-bin-"));
    temporaryDirs.push(dir);
    const binary = resolve(dir, "browser-rs");
    writeFileSync(binary, "#!/bin/sh\necho 'browser-rs 0.1.12'\n");

    expect(resolveBrowserRsBin(binary)).toBeUndefined();
    chmodSync(binary, 0o755);
    expect(resolveBrowserRsBin(binary)).toBe(binary);
  });

  test("fails closed for a pre-capability Browser.rs release", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-rs-old-bin-"));
    temporaryDirs.push(dir);
    const binary = resolve(dir, "browser-rs");
    writeFileSync(binary, "#!/bin/sh\necho 'browser-rs 0.1.11'\n");
    chmodSync(binary, 0o755);

    expect(resolveBrowserRsBin(binary)).toBeUndefined();
  });

  test("does not silently fall back to an arbitrary PATH binary", () => {
    expect(resolveBrowserRsBin("/definitely/missing/browser-rs")).toBeUndefined();
  });
});
