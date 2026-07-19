import { describe, expect, test } from "bun:test";
import { createSafeUnlink } from "#platform/file-utils";

describe("safe unlink factory", () => {
  test("uses caller-owned unlink and ignores missing files", () => {
    const calls: string[] = [];
    const safeUnlink = createSafeUnlink({
      unlink: (path) => {
        calls.push(path);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      warn: () => calls.push("warn"),
    });

    safeUnlink("/tmp/missing", "unlink failed");
    expect(calls).toEqual(["/tmp/missing"]);
  });

  test("reports non-ENOENT failures only when a label is provided", () => {
    const warnings: Array<{ path: string; message: string }> = [];
    const safeUnlink = createSafeUnlink({
      unlink: () => {
        throw new Error("denied");
      },
      warn: (context, message) => warnings.push({ path: context.path, message }),
    });

    safeUnlink("/tmp/silent");
    safeUnlink("/tmp/reported", "unlink failed");
    expect(warnings).toEqual([{ path: "/tmp/reported", message: "unlink failed" }]);
  });
});
