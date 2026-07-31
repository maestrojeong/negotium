import { describe, expect, test } from "bun:test";
import {
  isTopicBriefFile,
  isTopicSummaryFile,
  wikiBriefStorageKey,
  wikiSummaryFilename,
  wikiSummarySlug,
  wikiSummaryStorageSlug,
} from "#storage/wiki-summary-names";

describe("wiki summary naming", () => {
  const date = "2026-06-23";

  test("active topic memory is keyed by its readable title", () => {
    expect(wikiSummaryStorageSlug("Roadmap Notes", "topic-abc-123")).toBe("Roadmap-Notes");
    expect(wikiSummaryFilename(date, "Roadmap Notes", "topic-abc-123")).toBe(
      "2026-06-23-Roadmap-Notes.md",
    );
    expect(wikiBriefStorageKey("Roadmap Notes", "topic-abc-123")).toBe("Roadmap-Notes");
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(wikiSummaryStorageSlug(uuid, uuid)).toBe(wikiSummarySlug(uuid));
    expect(wikiBriefStorageKey(uuid, uuid)).toBe(uuid);
    expect(isTopicSummaryFile("2026-06-23-topic-abc-123.md", "topic-abc-123")).toBe(true);
  });

  test("equal titles intentionally share one memory namespace", () => {
    expect(wikiSummaryFilename(date, "Same Name", "topic-a")).toBe(
      wikiSummaryFilename(date, "Same Name", "topic-b"),
    );
    expect(wikiBriefStorageKey("Same Name", "topic-a")).toBe(
      wikiBriefStorageKey("Same Name", "topic-b"),
    );
    expect(isTopicSummaryFile(`${date}-Old-Title--topic-a.md`, "topic-a", "New Title")).toBe(true);
    expect(isTopicBriefFile("Old-Title--topic-a.md", "topic-a", "New Title")).toBe(true);
  });

  test("API matching keeps legacy id and title files visible", () => {
    expect(isTopicSummaryFile("2026-06-23-Roadmap-Notes.md", "topic-abc-123")).toBe(false);
    expect(
      isTopicSummaryFile("2026-06-23-Roadmap-Notes.md", "topic-abc-123", "Roadmap Notes"),
    ).toBe(true);
    expect(
      isTopicSummaryFile("2026-06-23-Roadmap-Notes~2.md", "topic-abc-123", "Roadmap Notes"),
    ).toBe(true);
    expect(isTopicSummaryFile("2026-06-23-Roadmap-2.md", "topic-abc-123", "Roadmap")).toBe(false);
    expect(isTopicSummaryFile("2026-06-23-Roadmap-2.md", "topic-abc-123", "Roadmap-2")).toBe(true);
    expect(isTopicBriefFile("topic-abc-123.md", "topic-abc-123", "Roadmap Notes")).toBe(true);
    expect(isTopicBriefFile("Roadmap-Notes.md", "topic-abc-123", "Roadmap Notes")).toBe(true);
  });

  test("ephemeral archiver topics fall back to the deleted topic title", () => {
    expect(wikiSummaryStorageSlug("Deleted Topic", "__archiver_deleted-topic")).toBe(
      "Deleted-Topic",
    );
    expect(wikiSummaryFilename(date, "Deleted Topic", "__archiver_deleted-topic")).toBe(
      "2026-06-23-Deleted-Topic.md",
    );
    expect(wikiBriefStorageKey("Deleted Topic", "__archiver_deleted-topic")).toBe("Deleted-Topic");
  });
});
