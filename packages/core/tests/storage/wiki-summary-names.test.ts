import { describe, expect, test } from "bun:test";
import {
  isTopicSummaryFile,
  wikiBriefStorageKey,
  wikiSummaryFilename,
  wikiSummaryStorageSlug,
} from "#storage/wiki-summary-names";

describe("wiki summary naming", () => {
  const date = "2026-06-23";

  test("active topic summaries are keyed by topic id, not title slug", () => {
    expect(wikiSummaryStorageSlug("Roadmap Notes", "topic-abc-123")).toBe("topic-abc-123");
    expect(wikiSummaryFilename(date, "Roadmap Notes", "topic-abc-123")).toBe(
      "2026-06-23-topic-abc-123.md",
    );
    expect(wikiBriefStorageKey("Roadmap Notes", "topic-abc-123")).toBe("topic-abc-123");
    expect(isTopicSummaryFile("2026-06-23-topic-abc-123.md", "topic-abc-123")).toBe(true);
  });

  test("API summary matching keeps legacy title-slug files visible", () => {
    expect(isTopicSummaryFile("2026-06-23-Roadmap-Notes.md", "topic-abc-123")).toBe(false);
    expect(
      isTopicSummaryFile("2026-06-23-Roadmap-Notes.md", "topic-abc-123", "Roadmap Notes"),
    ).toBe(true);
  });

  test("ephemeral archiver topics fall back to the deleted topic title", () => {
    expect(wikiSummaryStorageSlug("Deleted Topic", "__archiver_deleted-topic")).toBe(
      "Deleted-Topic",
    );
    expect(wikiSummaryFilename(date, "Deleted Topic", "__archiver_deleted-topic")).toBe(
      "2026-06-23-Deleted-Topic.md",
    );
    expect(wikiBriefStorageKey("Deleted Topic", "__archiver_deleted-topic")).toBe("Deleted Topic");
  });
});
