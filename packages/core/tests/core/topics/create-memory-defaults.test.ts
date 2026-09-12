import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getRegistry } from "#agents/registry";
import { assignTopicDefaults } from "#agents/topic-defaults";
import { DEFAULT_TOPIC_EFFORT } from "#platform/config";
import { deleteTopic } from "#storage/api-topics";
import { deleteTopicDefaultAssignment } from "#storage/topic-default-assignments";
import { registerTopic, registerTopicDetailed } from "#topics/create";

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

test("defaultsSource names the layer that actually chose the defaults", () => {
  const memoryKey = assign("opus", "high");

  const assigned = registerTopicDetailed({
    title: `Source assigned ${randomUUID()}`,
    userId: USER,
    memoryKey,
  });
  const explicit = registerTopicDetailed({
    title: `Source explicit ${randomUUID()}`,
    userId: USER,
    memoryKey,
    // A model without an agent is validated against FALLBACK_AGENT.
    model: "sonnet",
  });
  const fallback = registerTopicDetailed({
    title: `Source fallback ${randomUUID()}`,
    userId: USER,
  });
  createdTopicIds.push(assigned.topic.id, explicit.topic.id, fallback.topic.id);

  expect(assigned.defaultsSource).toBe("assigned");
  expect(explicit.defaultsSource).toBe("explicit");
  expect(fallback.defaultsSource).toBe("fallback");
});

test("a persona with no assignment reports fallback, not assigned", () => {
  const result = registerTopicDetailed({
    title: `Source unassigned ${randomUUID()}`,
    userId: USER,
    memoryKey: `create-defaults ${randomUUID()}`,
  });
  createdTopicIds.push(result.topic.id);

  expect(result.defaultsSource).toBe("fallback");
});

test("the node's fixed effort applies whichever backend the node defaults to", () => {
  const topic = create({ title: `Node effort ${randomUUID()}`, userId: USER });

  expect(topic.defaultEffort).toBe(DEFAULT_TOPIC_EFFORT);
});

test("a claude room does not inherit that registry's more expensive default effort", () => {
  const topic = create({ title: `Claude effort ${randomUUID()}`, userId: USER, agent: "claude" });

  expect(getRegistry("claude").defaultEffort).toBe("high");
  expect(topic.defaultEffort).toBe(DEFAULT_TOPIC_EFFORT);
});

test("an empty model is the caller having decided, not an opening for an assignment", () => {
  const memoryKey = assign("opus", "high");

  const result = registerTopicDetailed({
    title: `Empty model ${randomUUID()}`,
    userId: USER,
    memoryKey,
    model: "",
  });
  createdTopicIds.push(result.topic.id);

  expect(result.defaultsSource).toBe("explicit");
  // An explicit empty model must still suppress the memory assignment.
  expect(result.topic.defaultModel).not.toBe("opus");
});
