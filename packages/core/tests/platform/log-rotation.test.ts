import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateOversizedLog } from "#platform/log-rotation";

describe("rotateOversizedLog", () => {
  test("leaves a missing log alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-log-rotate-"));
    try {
      expect(() => rotateOversizedLog(join(dir, "node-daemon.log"), 10)).not.toThrow();
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves a log under the threshold untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-log-rotate-"));
    try {
      const logPath = join(dir, "node-daemon.log");
      writeFileSync(logPath, "small");
      rotateOversizedLog(logPath, 1024);
      expect(existsSync(logPath)).toBe(true);
      expect(readdirSync(dir)).toEqual(["node-daemon.log"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renames an oversized log aside so a fresh file can start", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-log-rotate-"));
    try {
      const logPath = join(dir, "node-daemon.log");
      writeFileSync(logPath, "x".repeat(20));
      rotateOversizedLog(logPath, 10);
      expect(existsSync(logPath)).toBe(false);
      const entries = readdirSync(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^node-daemon\.log\./);
      // A subsequent write to logPath starts a brand-new, empty file.
      writeFileSync(logPath, "fresh");
      expect(readdirSync(dir).sort()).toEqual([entries[0], "node-daemon.log"].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never throws even when the rename target is unwritable", () => {
    const dir = mkdtempSync(join(tmpdir(), "negotium-log-rotate-"));
    try {
      const logPath = join(dir, "missing-dir", "node-daemon.log");
      expect(() => rotateOversizedLog(logPath, 0)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
