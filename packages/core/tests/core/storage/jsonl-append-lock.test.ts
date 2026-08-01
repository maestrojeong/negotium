/**
 * Regression tests for the cross-process append lock added to
 * `appendJsonlEntry` in `src/platform/jsonl.ts`.
 *
 * The lock prevents POSIX `O_APPEND` interleaving when concurrent MCP
 * servers/bot processes write entries larger than PIPE_BUF (Linux 4 KB,
 * macOS 512 B) to the same file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonlEntry, JsonlLockTimeoutError } from "#platform/jsonl";

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

  test("Node+tsx MCP writer waits on contention without requiring the Bun global", async () => {
    const filePath = join(workDir, "node-contention.jsonl");
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, "");

    const coreDir = join(import.meta.dir, "../../..");
    const child = Bun.spawn(
      [
        "node",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        'import { appendJsonlEntry } from "./src/platform/jsonl.ts"; appendJsonlEntry(process.env.JSONL_TEST_FILE, { runtime: "node" });',
      ],
      {
        cwd: coreDir,
        env: { ...process.env, JSONL_TEST_FILE: filePath },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    await Bun.sleep(75);
    unlinkSync(lockPath);
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(readLines(filePath).map((line) => JSON.parse(line))).toEqual([{ runtime: "node" }]);
  });
});

describe("appendJsonlEntry — a dead holder never costs an entry", () => {
  test("an abandoned lock is waited out and reclaimed, at every age", () => {
    // A writer killed mid-append leaves its lock file behind; only the mtime
    // check reclaims it, at LOCK_STALE_MS. When the acquire timeout was shorter
    // than that threshold, every append issued in the first ~3.5s after such a
    // crash gave up before the reclaim could fire and was lost. The timeout now
    // outlasts staleness, so the entry always lands.
    for (const ageMs of [0, 1000, 3000]) {
      const filePath = join(workDir, `abandoned-${ageMs}.jsonl`);
      const lockPath = `${filePath}.lock`;
      writeFileSync(lockPath, "");
      if (ageMs > 0) {
        const backdated = Date.now() / 1000 - ageMs / 1000;
        utimesSync(lockPath, backdated, backdated);
      }

      appendJsonlEntry(filePath, { ageMs });

      expect(readLines(filePath)).toEqual([JSON.stringify({ ageMs })]);
      expect(existsSync(lockPath)).toBeFalse();
    }
  }, 30_000);

  test("a holder that stays alive past the timeout fails the append without writing", async () => {
    // The only remaining way to time out: a holder that keeps its lock fresh so
    // staleness never fires — a genuinely stuck writer. The refresher must live
    // in another process, because `appendJsonlEntry` blocks this thread on
    // `Atomics.wait` and no timer here could run during the attempt.
    const filePath = join(workDir, "live-holder.jsonl");
    appendJsonlEntry(filePath, { seq: 1 });
    const lockPath = `${filePath}.lock`;

    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { writeFileSync, utimesSync } = require("node:fs");
         const lock = process.env.LOCK;
         writeFileSync(lock, "");
         setInterval(() => {
           const now = Date.now() / 1000;
           try { utimesSync(lock, now, now); } catch { process.exit(0); }
         }, 250);`,
      ],
      { env: { ...process.env, LOCK: lockPath }, stdout: "ignore", stderr: "pipe" },
    );

    try {
      // Let the holder create the lock before we contend for it.
      while (!existsSync(lockPath)) await Bun.sleep(10);

      let thrown: unknown;
      try {
        appendJsonlEntry(filePath, { seq: 2 });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(JsonlLockTimeoutError);
      expect((thrown as JsonlLockTimeoutError).filePath).toBe(filePath);
      expect((thrown as Error).message).toInclude("nothing written");
      // Nothing was appended unlocked alongside the holder.
      expect(readLines(filePath)).toEqual([JSON.stringify({ seq: 1 })]);
    } finally {
      holder.kill();
      await holder.exited;
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }

    // Once the holder releases, appends resume normally.
    appendJsonlEntry(filePath, { seq: 2 });
    expect(readLines(filePath)).toEqual([JSON.stringify({ seq: 1 }), JSON.stringify({ seq: 2 })]);
  }, 30_000);
});

describe("appendJsonlEntry — true multi-process race", () => {
  test("concurrent OS processes never interleave a large payload", async () => {
    // The in-process test above cannot produce a real race: appendFileSync
    // calls are serialized by the event loop. These are separate OS processes
    // writing payloads far above PIPE_BUF (macOS 512 B, Linux 4 KB) at the
    // same time, which is the exact condition the lock exists for.
    // Kept deliberately small: `bun test` runs files in parallel, and a
    // heavier fan-out here starves neighbouring cross-process tests that wait
    // on a spawned runtime. Four writers with payloads above PIPE_BUF is
    // already sufficient to expose an interleave.
    const filePath = join(workDir, "multiproc.jsonl");
    const WRITERS = 4;
    const PER_WRITER = 6;
    const PAD = 2048; // macOS PIPE_BUF is 512 B
    const coreDir = join(import.meta.dir, "../../..");

    const children = Array.from({ length: WRITERS }, (_, w) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { appendJsonlEntry } from "./src/platform/jsonl.ts";
           const w = Number(process.env.W);
           for (let i = 0; i < ${PER_WRITER}; i++) {
             appendJsonlEntry(process.env.F, { w, i, pad: String(w).repeat(${PAD}) });
           }`,
        ],
        {
          cwd: coreDir,
          env: { ...process.env, F: filePath, W: String(w) },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );

    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }

    const lines = readLines(filePath);
    expect(lines.length).toBe(WRITERS * PER_WRITER);

    // Every line must be intact JSON — an interleaved write shows up here.
    const seen = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { w: number; i: number; pad: string };
      expect(parsed.pad).toBe(String(parsed.w).repeat(PAD));
      seen.add(`${parsed.w}:${parsed.i}`);
    }
    expect(seen.size).toBe(WRITERS * PER_WRITER);
    expect(existsSync(`${filePath}.lock`)).toBeFalse();
  }, 30_000);
});
