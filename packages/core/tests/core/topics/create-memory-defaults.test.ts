import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getRegistry } from "#agents/registry";
import { DEFAULT_TOPIC_EFFORT } from "#platform/config";
import { deleteTopic, getTopic } from "#storage/api-topics";
import { registerTopic } from "#topics/create";

const USER = "create-memory-defaults-user";
const createdTopicIds: string[] = [];

function create(options: Parameters<typeof registerTopic>[0]) {
  const topic = registerTopic(options);
  createdTopicIds.push(topic.id);
  return topic;
}

afterEach(() => {
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

test("memoryKey round-trips without changing execution defaults", () => {
  const plain = create({ title: `Plain ${randomUUID()}`, userId: USER });
  const memoryKey = `Persona ${randomUUID()}`;
  const remembered = create({ title: `Remembered ${randomUUID()}`, userId: USER, memoryKey });

  expect(remembered.memoryKey).toBe(memoryKey);
  expect(getTopic(remembered.id)?.memoryKey).toBe(memoryKey);
  expect(remembered.agent).toBe(plain.agent);
  expect(remembered.defaultModel).toBe(plain.defaultModel);
  expect(remembered.defaultEffort).toBe(plain.defaultEffort);
});

test("explicit execution fields remain independent of memoryKey", () => {
  const topic = create({
    title: `Explicit ${randomUUID()}`,
    userId: USER,
    memoryKey: `Persona ${randomUUID()}`,
    agent: "codex",
    model: "gpt-5.6-luna",
    effort: "high",
  });

  expect(topic.agent).toBe("codex");
  expect(topic.defaultModel).toBe("gpt-5.6-luna");
  expect(topic.defaultEffort).toBe("high");
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
