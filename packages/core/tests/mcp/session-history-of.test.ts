import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionCommMcpServer } from "#mcp/factories/session-comm";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { createDefaultSessionCommMcpHost } from "#mcp/session-comm/default-host";
import { SESSION_HISTORY_OF_TOOL_NAMES } from "#mcp/session-comm/history-tools";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { type ConversationEntry, getConversationPath } from "#storage/conversations";
import type { TopicDto } from "#types/api";

const userId = `session-history-of-${randomUUID()}`;
const otherUserId = `session-history-of-other-${randomUUID()}`;
const createdTopicIds: string[] = [];
const seededPaths: string[] = [];

function makeTopic(patch: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `session-history-of-topic-${randomUUID()}`,
    title: `History Of ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "claude",
    defaultModel: "opus",
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

function seed(principal: string, topic: TopicDto, entries: ConversationEntry[]): void {
  const path = getConversationPath(principal, topic.title);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  seededPaths.push(path);
}

function context(topic: TopicDto, patch: Partial<SessionCommContext> = {}): SessionCommContext {
  return {
    userId,
    currentTopic: topic.title,
    currentTopicId: topic.id,
    depth: 0,
    replyOnly: false,
    agent: "claude",
    ...patch,
  };
}

async function connect(ctx: SessionCommContext): Promise<Client> {
  const server = createSessionCommMcpServer(ctx, createDefaultSessionCommMcpHost());
  const client = new Client({ name: "session-history-of-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function text(result: CallResult): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? "";
}

function isError(result: CallResult): boolean {
  return result.isError === true;
}

const sample: ConversationEntry[] = [
  { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
  { ts: "t1", agent: "claude", event: { type: "user_message", content: "design the cache layer" } },
  { ts: "t2", agent: "claude", event: { type: "session", sessionId: "s2" } },
  { ts: "t3", agent: "claude", event: { type: "user_message", content: "ship it" } },
];

afterEach(() => {
  for (const path of seededPaths.splice(0)) rmSync(path, { force: true });
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

describe("cross-topic session history (*_session_history_of)", () => {
  test("registers the three read tools, also for reply-only turns", async () => {
    const source = makeTopic();
    for (const replyOnly of [false, true]) {
      const names = (await (await connect(context(source, { replyOnly }))).listTools()).tools.map(
        (tool) => tool.name,
      );
      for (const name of SESSION_HISTORY_OF_TOOL_NAMES) expect(names).toContain(name);
    }
  });

  test("reads, searches and lists boundaries of a topic visible in list_sessions", async () => {
    const source = makeTopic();
    const target = makeTopic();
    seed(userId, target, sample);
    const client = await connect(context(source));

    const boundaries = JSON.parse(
      text(
        await client.callTool({
          name: "list_session_boundaries_of",
          arguments: { to: target.title },
        }),
      ),
    );
    expect(boundaries.topic).toBe(target.title);
    expect(boundaries.sessions).toMatchObject([
      { sessionId: "s1", endedBy: "compacted" },
      { sessionId: "s2", endedBy: "active" },
    ]);

    const read = JSON.parse(
      text(
        await client.callTool({
          name: "read_session_history_of",
          arguments: { to: target.title, sessionId: "s1" },
        }),
      ),
    );
    expect(read.topic).toBe(target.title);
    expect(read.returned_entries).toBe(2);
    expect(read.content).toContain("design the cache layer");
    expect(read.content).not.toContain("ship it");

    const search = JSON.parse(
      text(
        await client.callTool({
          name: "search_session_history_of",
          arguments: { to: target.title, query: "SHIP" },
        }),
      ),
    );
    expect(search.matches).toMatchObject([{ entry: 4, sessionId: "s2" }]);
  });

  test("refuses the current topic and topics outside the session-comm scope", async () => {
    const source = makeTopic();
    seed(userId, source, sample);
    // Another person's room this user is not on the roster of: not listable.
    const foreign = makeTopic({ participants: [{ userId: otherUserId, role: "owner" }] });
    seed(otherUserId, foreign, sample);
    const client = await connect(context(source));

    for (const to of [source.title, foreign.title, "no-such-topic", "node/remote-topic"]) {
      const result = await client.callTool({ name: "read_session_history_of", arguments: { to } });
      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("not found");
    }
  });

  test("a subagent reads only topics it may tell_session", async () => {
    const parent = makeTopic();
    const sibling = makeTopic();
    const child = makeTopic({ isSubagent: true, parentTopicId: parent.id });
    seed(userId, parent, sample);
    seed(userId, sibling, sample);
    const client = await connect(context(child, { subagentParentTopicId: parent.id }));

    const toParent = await client.callTool({
      name: "read_session_history_of",
      arguments: { to: parent.title },
    });
    expect(isError(toParent)).toBe(false);
    expect(JSON.parse(text(toParent)).returned_entries).toBe(4);

    const toSibling = await client.callTool({
      name: "read_session_history_of",
      arguments: { to: sibling.title },
    });
    expect(isError(toSibling)).toBe(true);
    expect(text(toSibling)).toContain("subagents can read session history only");
  });

  test("one read budget spans every target in the turn", async () => {
    const previous = process.env.NEGOTIUM_SESSION_HISTORY_MAX_CALLS;
    process.env.NEGOTIUM_SESSION_HISTORY_MAX_CALLS = "2";
    try {
      const source = makeTopic();
      const a = makeTopic();
      const b = makeTopic();
      seed(userId, a, sample);
      seed(userId, b, sample);
      const client = await connect(context(source));

      for (const to of [a.title, b.title]) {
        const ok = await client.callTool({ name: "read_session_history_of", arguments: { to } });
        expect(isError(ok)).toBe(false);
      }
      const spent = await client.callTool({
        name: "read_session_history_of",
        arguments: { to: a.title },
      });
      expect(isError(spent)).toBe(true);
      expect(text(spent)).toContain("budget exhausted");
    } finally {
      if (previous === undefined) delete process.env.NEGOTIUM_SESSION_HISTORY_MAX_CALLS;
      else process.env.NEGOTIUM_SESSION_HISTORY_MAX_CALLS = previous;
    }
  });
});
