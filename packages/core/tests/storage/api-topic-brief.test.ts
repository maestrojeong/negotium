import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deleteTopicBrief, resolveTopicBrief, setTopicBrief } from "#storage/api-topic-brief";

test("resolveTopicBrief falls back to a legacy topic id", () => {
  const topicId = randomUUID();
  const title = `shared title ${randomUUID()}`;
  setTopicBrief(topicId, { briefMd: "legacy id memory" });

  try {
    const resolved = resolveTopicBrief(topicId, title);
    expect(resolved?.storageKey).toBe(topicId);
    expect(resolved?.brief.briefMd).toBe("legacy id memory");
  } finally {
    deleteTopicBrief(topicId);
  }
});

test("resolveTopicBrief prefers the shared title key", () => {
  const topicId = randomUUID();
  const title = `shared title ${randomUUID()}`;
  const titleKey = title.replaceAll(" ", "-");
  setTopicBrief(topicId, { briefMd: "legacy id memory" });
  setTopicBrief(titleKey, { briefMd: "shared title memory" });

  try {
    const resolved = resolveTopicBrief(topicId, title);
    expect(resolved?.storageKey).toBe(titleKey);
    expect(resolved?.brief.briefMd).toBe("shared title memory");
  } finally {
    deleteTopicBrief(topicId);
    deleteTopicBrief(titleKey);
  }
});
