import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTopicMemoryFilePaths } from "#storage/wiki";

const workspaceDir = mkdtempSync(join(tmpdir(), "otium-wiki-memory-"));

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("getTopicMemoryFilePaths", () => {
  test("checks fork origin archives when a fork inherits parent wiki memory", () => {
    const wikiDir = join(workspaceDir, "wiki");
    mkdirSync(join(wikiDir, "topic"), { recursive: true });
    mkdirSync(join(wikiDir, "archive"), { recursive: true });
    writeFileSync(join(wikiDir, "topic", "parenttopic.md"), "# ParentTopic\n");
    writeFileSync(join(wikiDir, "archive", "ParentTopic_2026-06-10.jsonl"), "{}\n");

    const paths = getTopicMemoryFilePaths(42, "ChildTopic", "ParentTopic", workspaceDir);

    expect(paths.memoryFiles).toEqual(["parenttopic.md"]);
    expect(paths.hasArchive).toBe(true);
  });
});
