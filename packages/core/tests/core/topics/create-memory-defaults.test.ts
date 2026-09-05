import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { assignTopicDefaults } from "#agents/topic-defaults";
import { deleteTopic } from "#storage/api-topics";
import { deleteTopicDefaultAssignment } from "#storage/topic-default-assignments";
import { registerTopic } from "#topics/create";

const USER = "create-memory-defaults-user";
const createdTopicIds: string[] = [];
const assignedKeys: string[] = [];

function create(options: Parameters<typeof registerTopic>[0]) {
  const topic = registerTopic(options);
  createdTopicIds.push(topic.id);
  return topic;
}

function assign(model: string, effort?: string) {
  const key = `create-defaults ${randomUUID()}`;
  assignedKeys.push(key);
  assignTopicDefaults({ memoryKey: key, model, ...(effort ? { effort } : {}) });
  return key;
}

afterEach(() => {
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
  for (const key of assignedKeys.splice(0)) deleteTopicDefaultAssignment(key);
});

test("a named persona opens the room on its assigned model, effort, and derived agent", () => {
  const memoryKey = assign("opus", "high");

  const topic = create({ title: `Assigned ${randomUUID()}`, userId: USER, memoryKey });

  expect(topic.agent).toBe("claude");
  // Aliases are stored as written and expanded by the registry at run time.
  expect(topic.defaultModel).toBe("opus");
  expect(topic.defaultEffort).toBe("high");
  expect(topic.memoryKey).toBe(memoryKey);
});

test("an assignment without an effort uses the node's fixed default", () => {
  const memoryKey = assign("sonnet");

  const topic = create({ title: `Assigned ${randomUUID()}`, userId: USER, memoryKey });

  expect(topic.agent).toBe("claude");
  expect(topic.defaultEffort).toBe("medium");
});

test("a caller that names a model keeps it, assignment or not", () => {
  const memoryKey = assign("opus", "high");

  const topic = create({
    title: `Explicit ${randomUUID()}`,
    userId: USER,
    memoryKey,
    agent: "codex",
    model: "gpt-5.6-luna",
  });

  expect(topic.agent).toBe("codex");
  expect(topic.defaultModel).toBe("gpt-5.6-luna");
});

test("naming only an agent still blocks the assignment, since that is a decision too", () => {
  const memoryKey = assign("opus", "high");

  const topic = create({
    title: `Agent only ${randomUUID()}`,
    userId: USER,
    memoryKey,
    agent: "maestro",
  });

  expect(topic.agent).toBe("maestro");
});

test("a channel room is never given an agent by an assignment", () => {
  const memoryKey = assign("opus", "high");

  const topic = create({
    title: `Channel ${randomUUID()}`,
    userId: USER,
    kind: "channel",
    memoryKey,
  });

  expect(topic.agent).toBeUndefined();
});

test("an unassigned persona is recorded without changing the node defaults", () => {
  const memoryKey = `create-defaults ${randomUUID()}`;
  const plain = create({ title: `Plain ${randomUUID()}`, userId: USER });

  const topic = create({ title: `Unassigned ${randomUUID()}`, userId: USER, memoryKey });

  expect(topic.memoryKey).toBe(memoryKey);
  expect(topic.agent).toBe(plain.agent);
  expect(topic.defaultModel).toBe(plain.defaultModel);
  expect(topic.defaultEffort).toBe(plain.defaultEffort);
});
