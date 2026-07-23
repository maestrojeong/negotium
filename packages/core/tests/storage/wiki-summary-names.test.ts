import { describe, expect, test } from "bun:test";
import {
  isTopicSummaryFile,
  wikiBriefStorageKey,
  wikiSummaryFilename,
  wikiSummarySlug,
  wikiSummaryStorageSlug,
} from "#storage/wiki-summary-names";

describe("wiki summary naming", () => {
  const date = "2026-06-23";

  test("active topic summaries are keyed by title, with UUID fallback for bare-UUID topics", () => {
    // Human-readable title → use title as key + slug
    expect(wikiSummaryStorageSlug("Roadmap Notes", "topic-abc-123")).toBe("Roadmap-Notes");
    expect(wikiSummaryFilename(date, "Roadmap Notes", "topic-abc-123")).toBe(
      "2026-06-23-Roadmap-Notes.md",
    );
    expect(wikiBriefStorageKey("Roadmap Notes", "topic-abc-123")).toBe("Roadmap Notes");
    // Bare UUID topic (no readable title) → fall back to topicId
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(wikiSummaryStorageSlug(uuid, uuid)).toBe(wikiSummarySlug(uuid));
    expect(wikiBriefStorageKey(uuid, uuid)).toBe(uuid);
    // Legacy id-keyed file is still matched
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
