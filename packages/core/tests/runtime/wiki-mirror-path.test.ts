import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveWikiMemoryMirror, resolveWikiMirrorPath } from "#runtime/turn-runner";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("latest summary selection prefers the newest title counter over the base file", async () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-mirror-"));
  roots.push(root);
  writeFileSync(join(root, "2026-07-30-negotium.md"), "first");
  await Bun.sleep(5);
  writeFileSync(join(root, "2026-07-30-negotium-2.md"), "second");
  writeFileSync(join(root, "2026-07-30-negotium--legacy-id.md"), "legacy");

  const path = resolveWikiMirrorPath(
    root,
    "2026-07-30-negotium.md",
    (filename) => filename.endsWith("--legacy-id.md"),
    (filename) => /^2026-07-30-negotium(?:-\d+)?\.md$/.test(filename),
    false,
  );

  expect(basename(path)).toBe("2026-07-30-negotium-2.md");
});

test("brief selection keeps the exact canonical title file", () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-mirror-"));
  roots.push(root);
  writeFileSync(join(root, "negotium.md"), "canonical");
  writeFileSync(join(root, "negotium--legacy-id.md"), "legacy");

  const path = resolveWikiMirrorPath(
    root,
    "negotium.md",
    (filename) => filename.endsWith("--legacy-id.md"),
    (filename) => filename === "negotium.md",
  );

  expect(basename(path)).toBe("negotium.md");
});

test("filesystem memory remains available without SQLite metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-memory-fallback-"));
  roots.push(root);
  const topicDir = join(root, "topic");
  const summariesDir = join(root, "summaries");
  mkdirSync(topicDir, { recursive: true });
  mkdirSync(summariesDir, { recursive: true });
  writeFileSync(join(topicDir, "negotium.md"), "brief");
  writeFileSync(join(summariesDir, "2026-07-29-negotium.md"), "older");
  await Bun.sleep(5);
  writeFileSync(join(summariesDir, "2026-07-30-negotium.md"), "newer");

  const memory = resolveWikiMemoryMirror(root, "legacy-id", "negotium");

  expect(memory.hasBriefFile).toBe(true);
  expect(basename(memory.briefFile)).toBe("negotium.md");
  expect(basename(memory.latestSummaryFile!)).toBe("2026-07-30-negotium.md");
});
