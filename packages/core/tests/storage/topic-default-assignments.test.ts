import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  deleteTopicDefaultAssignment,
  getTopicDefaultAssignment,
  listTopicDefaultAssignments,
  normalizeMemoryKey,
  upsertTopicDefaultAssignment,
} from "#storage/topic-default-assignments";

test("normalizeMemoryKey strips the wiki path shape and folds case", () => {
  expect(normalizeMemoryKey("topic/Negotium Node.md")).toBe("negotium-node");
  expect(normalizeMemoryKey("  Negotium Node  ")).toBe("negotium-node");
});

test("an assignment round-trips under any spelling of its key", () => {
  const key = `persona ${randomUUID()}`;
  try {
    const stored = upsertTopicDefaultAssignment({
      memoryKey: key,
      model: "sonnet",
      effort: "medium",
      reason: "routine routing work",
    });
    expect(stored?.model).toBe("sonnet");
    expect(stored?.assignCount).toBe(1);
    expect(getTopicDefaultAssignment(`topic/${key}.md`)?.reason).toBe("routine routing work");
  } finally {
    deleteTopicDefaultAssignment(key);
  }
});

test("re-assigning overwrites the pairing and counts the call", () => {
  const key = `persona ${randomUUID()}`;
  try {
    upsertTopicDefaultAssignment({ memoryKey: key, model: "sonnet" });
    const second = upsertTopicDefaultAssignment({ memoryKey: key, model: "opus", effort: "high" });
    expect(second?.model).toBe("opus");
    expect(second?.effort).toBe("high");
    expect(second?.assignCount).toBe(2);
  } finally {
    deleteTopicDefaultAssignment(key);
  }
});

test("an empty key or model writes nothing", () => {
  expect(upsertTopicDefaultAssignment({ memoryKey: "   ", model: "sonnet" })).toBeNull();
  expect(upsertTopicDefaultAssignment({ memoryKey: "persona", model: "  " })).toBeNull();
});

test("deleting reports whether a row was there", () => {
  const key = `persona ${randomUUID()}`;
  upsertTopicDefaultAssignment({ memoryKey: key, model: "sonnet" });
  expect(deleteTopicDefaultAssignment(key)).toBe(true);
  expect(deleteTopicDefaultAssignment(key)).toBe(false);
  expect(getTopicDefaultAssignment(key)).toBeNull();
});

test("listing returns the most recently assigned personas", () => {
  const key = `persona ${randomUUID()}`;
  try {
    upsertTopicDefaultAssignment({ memoryKey: key, model: "sonnet" });
    expect(
      listTopicDefaultAssignments(50).some((row) => row.memoryKey === normalizeMemoryKey(key)),
    ).toBe(true);
  } finally {
    deleteTopicDefaultAssignment(key);
  }
});
