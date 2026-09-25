/**
 * PR9 (MEDIUM): the hosted `ask_session` must decide every refusal — above all
 * the cross-principal one — before the pending-ask row exists, like the stdio
 * server does. A spy on `createPendingAsk` pins the order: a refused ask never
 * calls it, and a remote ask calls it only right before the hub is called.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { setRemoteSessionHubFetch } from "#mcp/session-comm/hub-remote-session";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import type { TopicDto } from "#types/api";

const events: string[] = [];

// bun's mock.module is process-global: snapshot the real module and restore it.
const realAsks = { ...(await import("#storage/session-asks")) };
mock.module("#storage/session-asks", () => ({
  ...realAsks,
  createPendingAsk: (args: Parameters<typeof realAsks.createPendingAsk>[0]) => {
    events.push(`pending:${args.to}`);
    return realAsks.createPendingAsk(args);
  },
}));
const { createDefaultSessionCommMcpHost } = await import("#mcp/session-comm/default-host");

afterAll(() => {
  mock.module("#storage/session-asks", () => realAsks);
});

const caller = `ask-order-caller-${randomUUID()}`;
const other = `ask-order-other-${randomUUID()}`;
const created: string[] = [];

function room(scope: string, patch: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `ask-order-${randomUUID()}`,
    title: `Ask Order ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    aiMention: false,
    participants: [{ userId: caller, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    surface: "otium",
    surfaceScope: scope,
    ...patch,
  };
  created.push(topic.id);
  upsertTopic(topic);
  return topic;
}

afterEach(() => {
  events.length = 0;
  setRemoteSessionHubFetch(null);
  for (const id of created.splice(0)) {
    db.run("DELETE FROM session_inbox WHERE topic_id = ?", [id]);
    db.run("DELETE FROM remote_session_asks WHERE caller_topic_id = ?", [id]);
    deleteTopic(id);
  }
});

function isError(result: unknown): boolean {
  return Boolean((result as { isError?: boolean }).isError);
}

describe("hosted ask_session: refusals come before the pending ask", () => {
  test("a local refusal never creates a pending ask; an accepted ask creates one", async () => {
    const scope = `ask-order-ws-${randomUUID()}`;
    const current = room(scope);
    const foreign = room(scope, { participants: [{ userId: other, role: "owner" }] });
    const noAi = room(scope);
    db.run(
      "UPDATE api_topics SET kind = 'channel', response_policy = 'off', agent = NULL WHERE id = ?",
      [noAi.id],
    );
    const mine = room(scope);
    const everything = [current.id, foreign.id, noAi.id, mine.id];
    const context: SessionCommContext = {
      userId: caller,
      actorUserId: "person",
      actorTopicScope: {
        visibleNodeTopicIds: everything,
        ownedNodeTopicIds: everything,
        issuedAt: Date.now(),
      },
      currentTopic: current.title,
      currentTopicId: current.id,
      depth: 0,
      replyOnly: false,
      agent: "codex",
    };
    const host = createDefaultSessionCommMcpHost();

    // Another principal's room: the principal check refuses before any row.
    const crossPrincipal = await host.askSession(context, { to: foreign.title, message: "?" });
    expect(isError(crossPrincipal)).toBe(true);
    expect(JSON.stringify(crossPrincipal)).toContain("different execution principal");
    // An unknown target and a room without AI: refused the same way.
    expect(isError(await host.askSession(context, { to: "nowhere", message: "?" }))).toBe(true);
    expect(isError(await host.askSession(context, { to: noAi.title, message: "?" }))).toBe(true);
    expect(events).toEqual([]);

    // The caller's own room: exactly one pending ask, then the inbox entry.
    const accepted = await host.askSession(context, { to: mine.title, message: "?" });
    expect(isError(accepted)).toBe(false);
    expect(events).toEqual([`pending:${mine.title}`]);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM session_inbox WHERE topic_id = ?",
        )
        .get(mine.id)?.n,
    ).toBe(1);
  });

  test("a remote refusal never creates a pending ask; a hub ask creates it right before sending", async () => {
    const scope = `ask-order-remote-${randomUUID()}`;
    const current = room(scope);
    const base: SessionCommContext = {
      userId: caller,
      actorUserId: "person",
      actorTopicScope: {
        visibleNodeTopicIds: [current.id],
        ownedNodeTopicIds: [current.id],
        issuedAt: Date.now(),
      },
      currentTopic: current.title,
      currentTopicId: current.id,
      depth: 0,
      replyOnly: false,
      agent: "codex",
    };
    const host = createDefaultSessionCommMcpHost();

    // On otium without the hub's grant the remote route is refused.
    expect(isError(await host.askSession(base, { to: "gmovie/Render", message: "?" }))).toBe(true);
    // Without a current topic id there is nowhere for the answer to return.
    expect(
      isError(
        await host.askSession(
          {
            ...base,
            currentTopicId: undefined,
            remoteSession: {
              hubUrl: "https://hub.example",
              capability: "rsc1.cGF5bG9hZA.c2lnbmF0dXJl",
            },
          },
          { to: "gmovie/Render", message: "?" },
        ),
      ),
    ).toBe(true);
    expect(events).toEqual([]);

    setRemoteSessionHubFetch(async () => {
      events.push("send");
      return Response.json({ ok: true, v: 1, replayed: false }, { status: 202 });
    });
    const sent = await host.askSession(
      {
        ...base,
        remoteSession: {
          hubUrl: "https://hub.example",
          capability: "rsc1.cGF5bG9hZA.c2lnbmF0dXJl",
        },
      },
      { to: "gmovie/Render", message: "?" },
    );
    expect(isError(sent)).toBe(false);
    expect(events).toEqual(["pending:gmovie/Render", "send"]);
  });
});
