import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  assignTopicDefaults,
  resolveAssignedTopicDefaults,
  validateAssignedDefaults,
} from "#agents/topic-defaults";
import {
  deleteTopicDefaultAssignment,
  upsertTopicDefaultAssignment,
} from "#storage/topic-default-assignments";

test("the agent is derived from the model, never supplied", () => {
  expect(validateAssignedDefaults("sonnet")?.agent).toBe("claude");
  expect(validateAssignedDefaults("deepseek-pro")?.agent).toBe("maestro");
  expect(validateAssignedDefaults("gpt-5.6-luna")?.agent).toBe("codex");
});

test("an unknown model is refused rather than mapped to a default", () => {
  expect(validateAssignedDefaults("not-a-model")).toBeNull();
  expect(validateAssignedDefaults("  ")).toBeNull();
});

test("an omitted or invalid effort falls back to the node's fixed default", () => {
  expect(validateAssignedDefaults("sonnet")?.effort).toBe("medium");
  expect(validateAssignedDefaults("sonnet", "turbo")?.effort).toBe("medium");
  expect(validateAssignedDefaults("sonnet", "HIGH")?.effort).toBe("high");
});

test("a stored assignment resolves back to model, effort, and derived agent", () => {
  const key = `persona ${randomUUID()}`;
  try {
    assignTopicDefaults({ memoryKey: key, model: "opus", effort: "high", reason: "hard work" });
    const resolved = resolveAssignedTopicDefaults(key);
    expect(resolved).toMatchObject({ agent: "claude", model: "opus", effort: "high" });
    expect(resolved?.reason).toBe("hard work");
  } finally {
    deleteTopicDefaultAssignment(key);
  }
});

test("assigning a model no agent owns stores nothing", () => {
  const key = `persona ${randomUUID()}`;
  expect(assignTopicDefaults({ memoryKey: key, model: "not-a-model" })).toBeNull();
  expect(resolveAssignedTopicDefaults(key)).toBeNull();
});

test("an unpublished codex id is accepted, matching that registry's open model list", () => {
  const key = `persona ${randomUUID()}`;
  try {
    expect(assignTopicDefaults({ memoryKey: key, model: "gpt-9-unreleased" })).toMatchObject({
      agent: "codex",
    });
  } finally {
    deleteTopicDefaultAssignment(key);
  }
});

test("a stored model that has since gone stale is ignored, not surfaced", () => {
  const key = `persona ${randomUUID()}`;
  try {
    // Written directly: the storage layer keeps whatever was valid at the time,
    // so the read path is what has to survive a later catalog change.
    upsertTopicDefaultAssignment({ memoryKey: key, model: "claude-retired-9" });
    expect(resolveAssignedTopicDefaults(key)).toBeNull();
  } finally {
    deleteTopicDefaultAssignment(key);
  }
});

test("no key and no assignment both mean no assignment", () => {
  expect(resolveAssignedTopicDefaults(undefined)).toBeNull();
  expect(resolveAssignedTopicDefaults("   ")).toBeNull();
  expect(resolveAssignedTopicDefaults(`persona ${randomUUID()}`)).toBeNull();
});
