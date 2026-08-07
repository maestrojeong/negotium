import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteApiTopicConfig, getApiTopicConfig } from "#storage/api-topic-config";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { Database } from "#storage/sqlite";
import { configureStorageHost } from "#storage/storage-host";
import type { TopicDto } from "#types/api";

const userId = `session-comm-user-${randomUUID()}`;
const currentTopicId = `session-comm-current-${randomUUID()}`;
const createdTopicIds: string[] = [];
const originalArgv = [...process.argv];

process.argv = [
  ...process.argv.slice(0, 2),
  `--user-id=${userId}`,
  "--topic=Current Room",
  `--topic-id=${currentTopicId}`,
];

const { getTopicsForUser, listSessionTargetsForUser } = await import("#mcp/session-comm/topics");
const { withDb } = await import("#mcp/session-comm/runtime");

function makeTopic(patch: Partial<TopicDto>): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `session-comm-topic-${randomUUID()}`,
    title: `Session Comm ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMode: "always",
    aiMention: false,
    participants: [{ userId, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    ...patch,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

afterEach(() => {
  for (const id of createdTopicIds.splice(0)) {
    deleteApiTopicConfig(id);
    deleteTopic(id);
  }
});

afterAll(() => {
  process.argv = originalArgv;
});

describe("session-comm database resolution", () => {
  /**
   * Regression cover for embedded Negotium splitting its state across two
   * databases. `withDb` used to open the import-time `SESSIONS_DB` constant,
   * which resolves to Negotium's own state directory — so when a host such as
   * Otium injected its connection through `configureStorageHost`, session-comm
   * silently read and wrote a different file than the rest of the process. No
   * error, no visible symptom; it was found in `lsof`.
   */
  test("borrows the host connection instead of opening SESSIONS_DB by path", () => {
    const dir = mkdtempSync(join(tmpdir(), "session-comm-host-"));
    const hostDb = new Database(join(dir, "host.db"), { create: true });
    const restore = configureStorageHost({ database: hostDb, dataDir: dir });
    try {
      hostDb.exec("CREATE TABLE host_marker (id INTEGER PRIMARY KEY)");
      hostDb.exec("INSERT INTO host_marker (id) VALUES (7)");
      // Only reachable through the very connection the host injected.
      const seen = withDb((database) => {
        const row = database.query("SELECT id FROM host_marker").get() as
          | { id: number }
          | undefined;
        return row?.id;
      });
      expect(seen).toBe(7);
      // Borrowed, so `withDb` must not close it on the way out.
      expect(() => hostDb.exec("SELECT 1 FROM host_marker")).not.toThrow();
    } finally {
      restore();
      hostDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to its own connection when no host is configured", () => {
    expect(withDb((database) => database.query("SELECT 1 AS ok").get())).toEqual({ ok: 1 });
  });
});

describe("session-comm topic listing", () => {
  test("excludes manager and current topics from inter-session targets", () => {
    const current = makeTopic({
      id: currentTopicId,
      title: "Current Room",
      kind: "agent",
    });
    const manager = makeTopic({
      title: "Manager Room",
      agent: "maestro",
    });
    db.query("UPDATE api_topics SET kind = 'manager' WHERE id = ?").run(manager.id);
    const target = makeTopic({
      title: "Target Room",
      kind: "agent",
    });

    const topics = getTopicsForUser();

    expect(topics[current.title]).toBeUndefined();
    expect(topics[`agent:${current.title}`]).toBeUndefined();
    expect(topics[manager.title]).toBeUndefined();
    expect(topics[`manager:${manager.title}`]).toBeUndefined();
    expect(topics[target.title]?.topicId).toBe(target.id);
    expect(topics[`agent:${target.title}`]?.topicId).toBe(target.id);
    expect(listSessionTargetsForUser().filter(({ topic }) => topic.topicId === target.id)).toEqual([
      { key: target.title, topic: topics[target.title] },
    ]);
  });

  test("current-topic MCP config uses topic id when duplicate titles exist", async () => {
    const current = makeTopic({
      id: currentTopicId,
      title: "Current Room",
      kind: "agent",
    });
    const duplicate = makeTopic({
      title: "Current Room",
      kind: "channel",
      agent: undefined,
      aiMode: "off",
      aiMention: false,
    });

    const { getMcpConfig, setMcpConfig } = await import("#mcp/session-comm/topic-config");

    setMcpConfig(["playwright"]);

    // Required MCPs are no longer persisted as topic-specific options. The
    // write must still resolve the current topic by id, not the duplicate title.
    expect(getApiTopicConfig(current.id)?.mcp).toEqual([]);
    expect(getApiTopicConfig(duplicate.id)).toBeUndefined();
    expect(getMcpConfig().enabled).toEqual([]);

    const targets = listSessionTargetsForUser();
    expect(targets.find(({ topic }) => topic.topicId === current.id)).toBeUndefined();
    expect(targets.find(({ topic }) => topic.topicId === duplicate.id)?.key).toBe(
      `channel:${duplicate.title}`,
    );
    expect(getTopicsForUser()[`channel:${duplicate.title}`]?.topicId).toBe(duplicate.id);
  });
});
