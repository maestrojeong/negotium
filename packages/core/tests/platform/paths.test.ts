import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideDir } from "#platform/paths";

test.skipIf(process.platform === "win32")(
  "isInsideDir resolves a symlinked ancestor for a child that does not exist yet",
  () => {
    const container = mkdtempSync(join(tmpdir(), "negotium-paths-"));
    const real = join(container, "real");
    const linked = join(container, "linked");
    mkdirSync(real);
    symlinkSync(real, linked);

    try {
      const missingChild = join(linked, "topics", "not-created-yet");
      expect(isInsideDir(missingChild, real)).toBe(true);
      expect(isInsideDir(missingChild, linked)).toBe(true);
      expect(isInsideDir(join(container, "outside"), real)).toBe(false);
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  },
);
