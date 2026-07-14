import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteProcessingFile, drainOutboxFile } from "#outbox/file-ops";

describe("outbox writer-race salvage", () => {
  test("late line appended to the claimed file is returned to pending, not lost", () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-race-"));
    const pending = join(dir, "topic.jsonl");
    appendFileSync(pending, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`);

    const drained = drainOutboxFile(pending, "race-test");
    expect(drained).not.toBeNull();
    if (!drained) return;
    expect(drained.lines.length).toBe(2);

    // Simulate a writer whose append raced the rename: the line lands on the
    // already-claimed .processing inode after the drainer read it.
    appendFileSync(drained.processingPath, `${JSON.stringify({ n: 3 })}\n`);

    deleteProcessingFile(drained.processingPath, "race-test", drained.lines.length);

    expect(existsSync(drained.processingPath)).toBe(false);
    const salvaged = readFileSync(pending, "utf-8").trim().split("\n");
    expect(salvaged).toEqual([JSON.stringify({ n: 3 })]);
  });

  test("no salvage when nothing raced — pending stays absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-race-"));
    const pending = join(dir, "topic.jsonl");
    appendFileSync(pending, `${JSON.stringify({ n: 1 })}\n`);

    const drained = drainOutboxFile(pending, "race-test");
    expect(drained).not.toBeNull();
    if (!drained) return;

    deleteProcessingFile(drained.processingPath, "race-test", drained.lines.length);
    expect(existsSync(drained.processingPath)).toBe(false);
    expect(existsSync(pending)).toBe(false);
  });
});
