import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { createDefaultSessionCommMcpHost } from "#mcp/session-comm/default-host";
import { sessionInboxPath } from "#query/session-inbox-path";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { listPendingAsksForCaller } from "#storage/session-asks";
import type { TopicDto } from "#types/api";

const userId = `session-default-host-${randomUUID()}`;
const createdTopicIds: string[] = [];
const inboxPaths: string[] = [];

function makeTopic(patch: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `session-default-topic-${randomUUID()}`,
    title: `Session Default ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
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

function context(topic: TopicDto): SessionCommContext {
  return {
    userId,
    currentTopic: topic.title,
    currentTopicId: topic.id,
    depth: 0,
    replyOnly: false,
    agent: "codex",
  };
}

afterEach(() => {
  for (const path of inboxPaths.splice(0)) {
    if (existsSync(path)) unlinkSync(path);
  }
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

describe("default session-comm MCP host", () => {
  test("writes tell_session messages to the target inbox", async () => {
    const source = makeTopic();
    const target = makeTopic();
    const inboxPath = sessionInboxPath(userId, target.id);
    inboxPaths.push(inboxPath);

    const result = await createDefaultSessionCommMcpHost().tellSession(context(source), {
      to: target.title,
      message: "hosted hello",
    });

    expect("isError" in result ? result.isError : false).not.toBe(true);
    const entries = readFileSync(inboxPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "tell",
      fromTopicId: source.id,
      message: "hosted hello",
      depth: 1,
    });
  });

  test("a room in one Otium workspace cannot address a room in another", async () => {
    const source = makeTopic({ surface: "otium", surfaceScope: "ws_alpha" });
    const sibling = makeTopic({ surface: "otium", surfaceScope: "ws_alpha" });
    const stranger = makeTopic({ surface: "otium", surfaceScope: "ws_beta" });
    inboxPaths.push(sessionInboxPath(userId, sibling.id), sessionInboxPath(userId, stranger.id));

    const host = createDefaultSessionCommMcpHost();
    const listed = await host.listSessions(context(source));
    const rendered = JSON.stringify(listed);
    expect(rendered).toContain(sibling.title);
    // Same surface, different workspace: the boundary the whole feature exists
    // for. A leak here would let one customer's node reach another's rooms.
    expect(rendered).not.toContain(stranger.title);

    const refused = await host.tellSession(context(source), {
      to: stranger.title,
      message: "should not arrive",
    });
    expect("isError" in refused ? refused.isError : false).toBe(true);
    expect(existsSync(sessionInboxPath(userId, stranger.id))).toBe(false);
  });

  test("clears pending asks when the target has no agent", async () => {
    const source = makeTopic();
    const target = makeTopic({ kind: "channel", agent: undefined, aiMode: "off" });
    const host = createDefaultSessionCommMcpHost();
    const current = context(source);

    const first = await host.askSession(current, { to: target.title, message: "question one" });
    const second = await host.askSession(current, { to: target.title, message: "question two" });

    expect("isError" in first ? first.isError : false).toBe(true);
    expect("isError" in second ? second.isError : false).toBe(true);
    expect(second.content[0]?.text).not.toContain("already pending");
    expect(listPendingAsksForCaller({ userId, from: `agent:${source.title}` })).toEqual([]);
  });
});
