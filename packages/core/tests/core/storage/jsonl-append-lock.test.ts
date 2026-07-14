/**
 * Regression tests for the cross-process append lock added to
 * `appendJsonlEntry` in `src/platform/jsonl.ts`.
 *
 * The lock prevents POSIX `O_APPEND` interleaving when concurrent MCP
 * servers/bot processes write entries larger than PIPE_BUF (Linux 4 KB,
 * macOS 512 B) to the same file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonlEntry } from "#platform/jsonl";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "jsonl-lock-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
}

describe("appendJsonlEntry — cross-process lock", () => {
  test("small entry append — fast path completes without leaving a lock", () => {
    const filePath = join(workDir, "small.jsonl");
    appendJsonlEntry(filePath, { kind: "small" });
    expect(readLines(filePath)).toEqual([JSON.stringify({ kind: "small" })]);
    expect(existsSync(`${filePath}.lock`)).toBe(false);
  });

  test("large entry (>PIPE_BUF on macOS=512B) — append still succeeds", () => {
    const filePath = join(workDir, "large.jsonl");
    const big = "x".repeat(8192);
    appendJsonlEntry(filePath, { payload: big });
    const [line] = readLines(filePath);
    const parsed = JSON.parse(line) as { payload: string };
    expect(parsed.payload.length).toBe(8192);
    expect(existsSync(`${filePath}.lock`)).toBe(false);
  });

  test("100 sequential appends — every entry survives in order", () => {
    const filePath = join(workDir, "seq.jsonl");
    for (let i = 0; i < 100; i++) appendJsonlEntry(filePath, { i });
    const lines = readLines(filePath);
    expect(lines.length).toBe(100);
    lines.forEach((line, idx) => {
      expect(JSON.parse(line)).toEqual({ i: idx });
    });
  });

  test("stale lock (mtime older than threshold) is reclaimed", () => {
    const filePath = join(workDir, "stale.jsonl");
    const lockPath = `${filePath}.lock`;
    // Pre-existing lock from a crashed process
    writeFileSync(lockPath, "");
    // Backdate mtime well beyond LOCK_STALE_MS=5000
    const old = Date.now() / 1000 - 30; // 30s ago
    require("node:fs").utimesSync(lockPath, old, old);

    appendJsonlEntry(filePath, { ok: true });
    expect(readLines(filePath)).toEqual([JSON.stringify({ ok: true })]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("parent directory is auto-created", () => {
    const filePath = join(workDir, "nested", "deep", "file.jsonl");
    appendJsonlEntry(filePath, { ok: 1 });
    expect(readLines(filePath)).toEqual([JSON.stringify({ ok: 1 })]);
  });

  test("concurrent in-process appends — no entry is lost or corrupted", async () => {
    const filePath = join(workDir, "concurrent.jsonl");
    // Within a single Bun process, appendFileSync calls run on the JS event
    // loop, so this is not a true multi-process race — but it does exercise
    // the lock acquire/release cycle and would catch a regression where the
    // lock keeps a stale file leftover. For real cross-process safety the
    // lock is exercised by the bot/MCP runtime.
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        appendJsonlEntry(filePath, { i, payload: "y".repeat(2048) });
      }),
    );
    const lines = readLines(filePath);
    expect(lines.length).toBe(N);
    const parsed = lines.map((l) => JSON.parse(l) as { i: number });
    const seen = new Set(parsed.map((p) => p.i));
    expect(seen.size).toBe(N);
    expect(existsSync(`${filePath}.lock`)).toBe(false);
  });
});
