import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BoundedOutputStream,
  utf8SafeEnd,
  utf8SafeStart,
} from "#platform/background-bash/output-buffer";

const tmp = mkdtempSync(join(tmpdir(), "bg-bash-buffer-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HANGUL = "한"; // U+D55C — 1 UTF-16 unit, 3 UTF-8 bytes
const EMOJI = "🎉"; // U+1F389 — 2 UTF-16 units (surrogate pair), 4 UTF-8 bytes

describe("BoundedOutputStream — byte accounting", () => {
  test("counts UTF-8 bytes, not UTF-16 code units", () => {
    // The old appendBounded compared String.length against a byte cap, so this
    // input (30_000 bytes) looked like 10_000 and escaped truncation entirely.
    const stream = new BoundedOutputStream({ maxBytes: 4096 });
    stream.append(Buffer.from(HANGUL.repeat(10_000), "utf-8"));

    expect(stream.totalBytes).toBe(30_000);
    const snap = stream.snapshot();
    expect(snap.truncated).toBeTrue();
    expect(Buffer.byteLength(snap.text, "utf-8")).toBeLessThanOrEqual(4096 + 64); // + notice
    expect(snap.omittedBytes).toBeGreaterThan(0);
    expect(snap.totalBytes).toBe(30_000);
  });

  test("passes short output through byte-for-byte", () => {
    const stream = new BoundedOutputStream({ maxBytes: 4096 });
    const text = `${HANGUL}glish ${EMOJI} mixed\nsecond line\n`;
    stream.append(Buffer.from(text, "utf-8"));

    const snap = stream.snapshot();
    expect(snap.text).toBe(text);
    expect(snap.truncated).toBeFalse();
    expect(snap.omittedBytes).toBe(0);
  });
});

describe("BoundedOutputStream — UTF-8 boundary safety", () => {
  test("never emits replacement characters when the cut lands mid-character", () => {
    // Every budget offset lands somewhere different inside a 3-byte sequence,
    // so at least one of these would split a character without correction.
    for (let maxBytes = 1024; maxBytes <= 1030; maxBytes++) {
      const stream = new BoundedOutputStream({ maxBytes });
      stream.append(Buffer.from(HANGUL.repeat(5000), "utf-8"));
      expect(stream.snapshot().text).not.toInclude("�");
    }
  });

  test("reassembles a character split across two chunks", () => {
    // Decoding each chunk independently (the old `c.toString("utf-8")`) turns
    // this into two replacement characters.
    const stream = new BoundedOutputStream({ maxBytes: 4096 });
    const bytes = Buffer.from(HANGUL, "utf-8");
    stream.append(bytes.subarray(0, 1));
    stream.append(bytes.subarray(1));

    expect(stream.snapshot().text).toBe(HANGUL);
  });

  test("keeps surrogate pairs intact across the truncation seam", () => {
    const stream = new BoundedOutputStream({ maxBytes: 2048 });
    stream.append(Buffer.from(EMOJI.repeat(4000), "utf-8"));

    const snap = stream.snapshot();
    expect(snap.truncated).toBeTrue();
    expect(snap.text).not.toInclude("�");
  });

  test("utf8SafeEnd/utf8SafeStart trim only incomplete sequences", () => {
    const full = Buffer.from(HANGUL, "utf-8");
    expect(utf8SafeEnd(full)).toBe(3);
    expect(utf8SafeEnd(full.subarray(0, 2))).toBe(0); // incomplete → dropped
    expect(utf8SafeStart(full.subarray(1))).toBe(2); // orphan continuations skipped
    expect(utf8SafeEnd(Buffer.from("abc"))).toBe(3);
    expect(utf8SafeStart(Buffer.from("abc"))).toBe(0);
  });
});

describe("BoundedOutputStream — truncation shape", () => {
  test("keeps the head and the tail, drops the middle", () => {
    const stream = new BoundedOutputStream({ maxBytes: 2048 });
    stream.append(Buffer.from("HEAD-MARKER\n", "utf-8"));
    stream.append(Buffer.from("x".repeat(100_000), "utf-8"));
    stream.append(Buffer.from("\nTAIL-MARKER", "utf-8"));

    const snap = stream.snapshot();
    expect(snap.text).toStartWith("HEAD-MARKER\n");
    expect(snap.text).toEndWith("TAIL-MARKER");
    expect(snap.text).toInclude("omitted");
    expect(snap.totalBytes).toBe(12 + 100_000 + 12);
  });

  test("stays bounded and cheap across many small chunks", () => {
    // The old implementation settled 15 bytes above the cap, so every chunk
    // after the first truncation re-sliced the entire buffer.
    const stream = new BoundedOutputStream({ maxBytes: 200_000 });
    for (let i = 0; i < 20_000; i++) stream.append(Buffer.from("y".repeat(100), "utf-8"));

    const snap = stream.snapshot();
    expect(snap.totalBytes).toBe(2_000_000);
    expect(Buffer.byteLength(snap.text, "utf-8")).toBeLessThanOrEqual(200_000 + 64);
  });
});

describe("BoundedOutputStream — incremental reads", () => {
  test("returns only new bytes and reports no gap while within budget", () => {
    const stream = new BoundedOutputStream({ maxBytes: 8192 });
    stream.append(Buffer.from("first\n", "utf-8"));

    const a = stream.readSince(0);
    expect(a.text).toBe("first\n");
    expect(a.droppedBytes).toBe(0);

    stream.append(Buffer.from("second\n", "utf-8"));
    const b = stream.readSince(a.nextCursor);
    expect(b.text).toBe("second\n");
    expect(b.droppedBytes).toBe(0);

    const c = stream.readSince(b.nextCursor);
    expect(c.text).toBe("");
    expect(c.nextCursor).toBe(b.nextCursor);
  });

  test("does not split a character across two polls", () => {
    const stream = new BoundedOutputStream({ maxBytes: 8192 });
    const bytes = Buffer.from(HANGUL, "utf-8");

    stream.append(bytes.subarray(0, 2)); // partial sequence
    const partial = stream.readSince(0);
    expect(partial.text).toBe("");
    expect(partial.nextCursor).toBe(0); // cursor held back

    stream.append(bytes.subarray(2));
    const complete = stream.readSince(partial.nextCursor);
    expect(complete.text).toBe(HANGUL);
  });

  test("reports dropped bytes when the cursor ages out of the window", () => {
    const stream = new BoundedOutputStream({ maxBytes: 2048 });
    stream.append(Buffer.from("z".repeat(100_000), "utf-8"));

    const read = stream.readSince(0);
    expect(read.droppedBytes).toBeGreaterThan(0);
    expect(read.nextCursor).toBe(100_000);
    // Honest accounting: what we returned plus what we admitted losing covers
    // everything the caller had not seen.
    expect(Buffer.byteLength(read.text, "utf-8") + read.droppedBytes).toBe(100_000);
  });
});

describe("BoundedOutputStream — spill", () => {
  test("spill file holds the complete output even when the preview is truncated", () => {
    const spillPath = join(tmp, "complete", "stdout.log");
    const stream = new BoundedOutputStream({ maxBytes: 2048, spillPath });
    const payload = `${HANGUL.repeat(20_000)}${EMOJI}`;
    stream.append(Buffer.from(payload, "utf-8"));
    stream.close();

    const snap = stream.snapshot();
    expect(snap.truncated).toBeTrue();
    expect(snap.spillPath).toBe(spillPath);
    expect(snap.spillError).toBeUndefined();
    expect(readFileSync(spillPath, "utf-8")).toBe(payload);
  });

  test("does not advertise a spill path before the file exists", () => {
    // The file is opened lazily on the first chunk. A silent stream has no
    // file, so `background_bash_output` must not hand back a path to nothing.
    const spillPath = join(tmp, "silent", "stdout.log");
    const stream = new BoundedOutputStream({ maxBytes: 4096, spillPath });

    expect(stream.spillPath).toBeUndefined();
    expect(stream.snapshot().spillPath).toBeUndefined();
    expect(existsSync(spillPath)).toBeFalse();

    stream.append(Buffer.from("now there is output\n", "utf-8"));
    expect(stream.spillPath).toBe(spillPath);
    expect(existsSync(spillPath)).toBeTrue();

    // Still reported after close: the file exists and holds the record.
    stream.close();
    expect(stream.spillPath).toBe(spillPath);
  });

  test("stops claiming completeness when output arrives after close", () => {
    // `child.on("error")` finishes the process while the pipes may still be
    // open, so a late chunk can reach the preview after the descriptor closed.
    // Previously the spill silently diverged while `spillPath` still advertised
    // it as the complete record.
    const spillPath = join(tmp, "late", "stdout.log");
    const stream = new BoundedOutputStream({ maxBytes: 4096, spillPath });
    stream.append(Buffer.from("before-close\n", "utf-8"));
    stream.close();
    stream.append(Buffer.from("AFTER-CLOSE\n", "utf-8"));

    const snap = stream.snapshot();
    expect(snap.text).toInclude("AFTER-CLOSE");
    expect(readFileSync(spillPath, "utf-8")).not.toInclude("AFTER-CLOSE");
    // The invariant: never point at a file that does not hold what we counted.
    expect(snap.spillPath).toBeUndefined();
    expect(snap.spillError).toInclude("incomplete");
  });

  test("reports the failure instead of claiming recoverability", () => {
    // Put a regular file where the spill's parent directory has to be, so
    // mkdirSync fails and the spill can never open.
    const blocker = join(tmp, "blocker");
    writeFileSync(blocker, "not a directory");
    const stream = new BoundedOutputStream({
      maxBytes: 1024,
      spillPath: join(blocker, "stdout.log"),
    });

    stream.append(Buffer.from("data", "utf-8"));
    const snap = stream.snapshot();
    expect(snap.spillError).toBeDefined();
    expect(snap.spillPath).toBeUndefined();
    // The preview itself must survive a spill failure.
    expect(snap.text).toBe("data");
  });
});
