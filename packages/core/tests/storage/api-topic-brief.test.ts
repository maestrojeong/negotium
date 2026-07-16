import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deleteTopicBrief, resolveTopicBrief, setTopicBrief } from "#storage/api-topic-brief";

test("resolveTopicBrief falls back to a legacy title key", () => {
  const topicId = randomUUID();
  const legacyTitle = `legacy-${randomUUID()}`;
  setTopicBrief(legacyTitle, { briefMd: "legacy memory" });

  try {
    const resolved = resolveTopicBrief(topicId, legacyTitle);
    expect(resolved?.storageKey).toBe(legacyTitle);
    expect(resolved?.brief.briefMd).toBe("legacy memory");
  } finally {
    deleteTopicBrief(legacyTitle);
  }
});

test("resolveTopicBrief prefers the current topic id", () => {
  const topicId = randomUUID();
  const legacyTitle = `legacy-${randomUUID()}`;
  setTopicBrief(topicId, { briefMd: "current memory" });
  setTopicBrief(legacyTitle, { briefMd: "legacy memory" });

  try {
    const resolved = resolveTopicBrief(topicId, legacyTitle);
    expect(resolved?.storageKey).toBe(topicId);
    expect(resolved?.brief.briefMd).toBe("current memory");
  } finally {
    deleteTopicBrief(topicId);
    deleteTopicBrief(legacyTitle);
  }
});
