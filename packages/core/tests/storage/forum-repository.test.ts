import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { addTopic, getSessionForTopic, getTopicByName, removeTopic } from "#storage/forum/index";
import { db } from "#storage/forum-db";

const created: Array<{ userId: number; topicName: string }> = [];

afterEach(() => {
  for (const item of created.splice(0)) {
    removeTopic(item.userId, item.topicName);
    db.query("DELETE FROM users WHERE id = ?").run(String(item.userId));
  }
});

describe("topic repository", () => {
  test("topics schema does not keep removed forum compatibility columns", () => {
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(topics)")
      .all()
      .map((c) => c.name);

    expect(columns).not.toContain("privacy_mode");
    expect(columns).not.toContain("advisor_enabled");
    expect(columns).not.toContain("agent_settings");
  });

  test("addTopic without a session id preserves the existing session on conflict", () => {
    const userId = 91_000 + Math.floor(Math.random() * 1_000);
    const topicName = `repo-${randomUUID()}`;
    created.push({ userId, topicName });

    addTopic(userId, topicName, 101, "session-1", "2026-06-01T00:00:00.000Z");
    addTopic(userId, topicName, 202, undefined, "2026-06-02T00:00:00.000Z");

    expect(getSessionForTopic(userId, topicName)).toBe("session-1");
    expect(getTopicByName(userId, topicName)?.messageThreadId).toBe(202);
  });
});
