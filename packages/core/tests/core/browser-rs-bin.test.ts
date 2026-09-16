import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  BINARY_EXTENSION,
  BROWSER_RS_MIN_SECURE_VERSION,
  BROWSER_RS_VERSION,
  resolveBrowserMcpBin,
  resolveBrowserRsBin,
} from "#platform/config";

// The two cases below gate on the POSIX execute bit and run their fixture
// through a `#!/bin/sh` shebang. Windows has neither: `chmod` does not change
// executability and a extension-less shell script cannot be spawned, so the
// mechanism under test does not exist there rather than being broken.
const posixOnly = test.skipIf(process.platform === "win32");

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Browser.rs executable resolution", () => {
  test("keeps the tested Browser.rs release pinned", () => {
    expect(BROWSER_RS_VERSION).toBe("v0.6.0");
    expect(BROWSER_RS_MIN_SECURE_VERSION).toBe("0.2.1");
  });

  posixOnly("accepts only an executable explicit override", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-rs-bin-"));
    temporaryDirs.push(dir);
    const binary = resolve(dir, "browser-rs");
    writeFileSync(binary, "#!/bin/sh\necho 'browser-rs 0.2.1'\n");

    expect(resolveBrowserRsBin(binary)).toBeUndefined();
    chmodSync(binary, 0o755);
    expect(resolveBrowserRsBin(binary)).toBe(binary);
  });

  posixOnly("fails closed for a pre-strict Browser.rs release", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-browser-rs-old-bin-"));
    temporaryDirs.push(dir);
    const binary = resolve(dir, "browser-rs");
    writeFileSync(binary, "#!/bin/sh\necho 'browser-rs 0.2.0'\n");
    chmodSync(binary, 0o755);

    expect(resolveBrowserRsBin(binary)).toBeUndefined();
  });

  test("does not silently fall back to an arbitrary PATH binary", () => {
    expect(resolveBrowserRsBin("/definitely/missing/browser-rs")).toBeUndefined();
  });

  test("resolves the managed Browser.rs binary directly", () => {
    // Compare on the basename rather than a "/"-anchored suffix: the resolved
    // path carries the host separator, and Windows needs the `.exe` the
    // release asset actually ships.
    const managed = resolveBrowserMcpBin();
    expect(basename(managed)).toBe(`browser-rs${BINARY_EXTENSION}`);
    expect(managed).toContain(BROWSER_RS_VERSION);

    // `resolve` so the expectation carries whatever root the host applies to
    // an absolute override (a drive letter on Windows).
    const override = resolve("/opt/negotium/browser-rs");
    expect(resolveBrowserMcpBin(override)).toBe(override);
  });
});
