import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathInside } from "#runtime/visuals";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("workspace path containment", () => {
  test("accepts an existing file through an equivalent filesystem alias", () => {
    const root = mkdtempSync(join(tmpdir(), "negotium-path-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    mkdirSync(workspace);
    symlinkSync(workspace, alias);
    writeFileSync(join(workspace, "result.txt"), "ok");

    expect(isPathInside(alias, join(realpathSync(workspace), "result.txt"))).toBe(true);
  });

  test("rejects a symlink that escapes the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "negotium-path-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    mkdirSync(workspace);
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(workspace, "escape.txt"));

    expect(isPathInside(workspace, join(workspace, "escape.txt"))).toBe(false);
  });
});
