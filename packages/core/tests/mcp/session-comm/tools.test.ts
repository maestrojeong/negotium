import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SESSION_COMM_SERVER } from "#platform/config";
import { clearQueryState, writeQueryState } from "#query/state";
import { encodeActorTopicScopeArg } from "#runtime/actor-topic-scope";
import { encodeRemoteSessionGrantArg } from "#runtime/remote-session-grant";
import { upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { clearPendingAsk } from "#storage/session-asks";
import { registerTopic } from "#topics/create";
import { ensurePersonalGeneral } from "#topics/personal-general";

const USER_ID = `session-tools-${randomUUID()}`;

async function listSessionCommTools(args: {
  title: string;
  topicId: string;
  subagentParentTopicId?: string;
  agent: "claude" | "codex" | "maestro";
  cronSessionId?: string;
}): Promise<string[]> {
  const client = new Client({ name: "session-comm-tools-test", version: "1.0.0" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "run",
      SESSION_COMM_SERVER,
      `--user-id=${USER_ID}`,
      `--topic=${args.title}`,
      `--topic-id=${args.topicId}`,
      ...(args.subagentParentTopicId
        ? [`--subagent-parent-topic-id=${args.subagentParentTopicId}`]
        : []),
      "--depth=0",
      `--agent=${args.agent}`,
      ...(args.cronSessionId ? [`--cron-session-id=${args.cronSessionId}`] : []),
    ],
    env,
  });

  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

async function listSessionsText(args: {
  title: string;
  topicId: string;
  agent: "claude" | "codex" | "maestro";
}): Promise<string> {
  const client = new Client({ name: "session-comm-list-test", version: "1.0.0" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "run",
      SESSION_COMM_SERVER,
      `--user-id=${USER_ID}`,
      `--topic=${args.title}`,
      `--topic-id=${args.topicId}`,
      "--depth=0",
      `--agent=${args.agent}`,
    ],
    env,
  });

  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "list_sessions", arguments: {} });
    return (result.content as Array<{ type: string; text?: string }>)
      .map((entry) => entry.text ?? "")
      .join("\n");
  } finally {
    await client.close();
  }
}

async function peekSessionsText(args: {
  title: string;
  topicId: string;
  agent: "claude" | "codex" | "maestro";
}): Promise<string> {
  const client = new Client({ name: "session-comm-peek-test", version: "1.0.0" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "run",
      SESSION_COMM_SERVER,
      `--user-id=${USER_ID}`,
      `--topic=${args.title}`,
      `--topic-id=${args.topicId}`,
      "--depth=0",
      `--agent=${args.agent}`,
    ],
    env,
  });

  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "peek_session", arguments: {} });
    return (result.content as Array<{ type: string; text?: string }>)
      .map((entry) => entry.text ?? "")
      .join("\n");
  } finally {
    await client.close();
  }
}

async function callSessionCommTool(args: {
  title: string;
  topicId: string;
  agent: "claude" | "codex" | "maestro";
  cronSessionId?: string;
  /** Extra launch arguments, e.g. the hub's `--actor-topic-scope=`. */
  extraArgs?: string[];
  name: string;
  input: Record<string, unknown>;
}): Promise<{ text: string; isError?: boolean }> {
  const client = new Client({ name: "session-comm-call-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "run",
      SESSION_COMM_SERVER,
      `--user-id=${USER_ID}`,
      `--topic=${args.title}`,
      `--topic-id=${args.topicId}`,
      "--depth=0",
      `--agent=${args.agent}`,
      ...(args.cronSessionId ? [`--cron-session-id=${args.cronSessionId}`] : []),
      ...(args.extraArgs ?? []),
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: args.name, arguments: args.input });
    return {
      text: (result.content as Array<{ type: string; text?: string }>)
        .map((entry) => entry.text ?? "")
        .join("\n"),
      isError: result.isError === true,
    };
  } finally {
    await client.close();
  }
}

function expectCommunicationContract(names: string[]): void {
  expect(names).toEqual(
    expect.arrayContaining([
      "list_sessions",
      "peek_session",
      "tell_session",
      "ask_session",
      "ask_cron",
      "abort_session",
    ]),
  );
  expect(names).not.toContain("send_message");
}

function otiumRoom(title: string, scope: string, patch: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const topic = {
    id: randomUUID(),
    title,
    kind: "agent" as const,
    agent: "codex" as const,
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium" as const,
    aiMode: "always" as const,
    aiMention: false,
    participants: [{ userId: USER_ID, role: "owner" as const }],
    createdAt: now,
    lastMessageAt: now,
    surface: "otium" as const,
    surfaceScope: scope,
    ...patch,
  };
  upsertTopic(topic);
  return topic;
}

/**
 * The stdio server (`NEGOTIUM_BUILTIN_MCP_TRANSPORT=stdio`) is a second
 * implementation of the same tools. It shares the owner and peer rules with the
 * hosted host through `actor-policy.ts`; this pins that the stdio path really
 * applies them, since it once applied only the visibility filter.
 */
describe("session-comm stdio server on the Otium surface", () => {
  test("abort_session refuses a visible-but-not-owned room as not found", async () => {
    const scope = `ws-stdio-${randomUUID()}`;
    const current = otiumRoom(`stdio-current-${randomUUID()}`, scope);
    const invited = otiumRoom(`stdio-invited-${randomUUID()}`, scope);
    const owned = otiumRoom(`stdio-owned-${randomUUID()}`, scope);
    const scopeArg = `--actor-topic-scope=${encodeActorTopicScopeArg({
      visibleNodeTopicIds: [current.id, invited.id, owned.id],
      ownedNodeTopicIds: [current.id, owned.id],
    })}`;
    try {
      const refused = await callSessionCommTool({
        title: current.title,
        topicId: current.id,
        agent: "codex",
        extraArgs: ["--actor-user-id=person", scopeArg],
        name: "abort_session",
        input: { to: invited.title },
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("not found");
      const allowed = await callSessionCommTool({
        title: current.title,
        topicId: current.id,
        agent: "codex",
        extraArgs: ["--actor-user-id=person", scopeArg],
        name: "abort_session",
        input: { to: owned.title },
      });
      expect(allowed.isError).toBe(false);
      const inbox = (topicId: string) =>
        db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence",
          )
          .all(topicId)
          .map((row) => JSON.parse(row.payload).type);
      expect(inbox(invited.id)).toEqual([]);
      expect(inbox(owned.id)).toEqual(["abort"]);
    } finally {
      for (const topic of [current, invited, owned]) {
        db.run("DELETE FROM session_inbox WHERE topic_id = ?", [topic.id]);
        db.run("DELETE FROM api_topics WHERE id = ?", [topic.id]);
      }
    }
  });

  test("Q1: two-owner and human-principal rooms are reachable per the assertion, strangers are not", async () => {
    const scope = `ws-stdio-q1-${randomUUID()}`;
    const human = `stdio-human-${randomUUID()}`;
    const stranger = `stdio-stranger-${randomUUID()}`;
    const current = otiumRoom(`stdio-q1-current-${randomUUID()}`, scope);
    const dual = otiumRoom(`stdio-q1-dual-${randomUUID()}`, scope, {
      participants: [
        { userId: USER_ID, role: "owner" as const },
        { userId: human, role: "owner" as const },
      ],
    });
    const humanRoom = otiumRoom(`stdio-q1-human-${randomUUID()}`, scope, {
      participants: [{ userId: human, role: "owner" as const }],
    });
    const strangerRoom = otiumRoom(`stdio-q1-stranger-${randomUUID()}`, scope, {
      participants: [{ userId: stranger, role: "owner" as const }],
    });
    const scopeArg = `--actor-topic-scope=${encodeActorTopicScopeArg({
      visibleNodeTopicIds: [current.id, dual.id, humanRoom.id],
      ownedNodeTopicIds: [current.id, humanRoom.id],
    })}`;
    const call = (name: string, input: Record<string, unknown>) =>
      callSessionCommTool({
        title: current.title,
        topicId: current.id,
        agent: "codex",
        extraArgs: [`--actor-user-id=${human}`, scopeArg],
        name,
        input,
      });
    const inbox = (topicId: string) =>
      db
        .query<{ user_id: string; payload: string }, [string]>(
          "SELECT user_id, payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence",
        )
        .all(topicId)
        .map((row) => `${row.user_id}:${JSON.parse(row.payload).type}`);
    try {
      const listed = (await call("list_sessions", {})).text;
      expect(listed).toContain(dual.title);
      expect(listed).toContain(humanRoom.title);
      expect(listed).not.toContain(strangerRoom.title);

      expect((await call("tell_session", { to: dual.title, message: "hi" })).isError).toBe(false);
      expect((await call("tell_session", { to: humanRoom.title, message: "hi" })).isError).toBe(
        false,
      );
      expect((await call("abort_session", { to: humanRoom.title })).isError).toBe(false);
      const asked = await call("ask_session", { to: humanRoom.title, message: "?" });
      expect(asked.isError).toBe(true);
      expect(asked.text).toContain("execution principal");
      expect(inbox(dual.id)).toEqual([`${USER_ID}:tell`]);
      expect(inbox(humanRoom.id)).toEqual([`${human}:tell`, `${human}:abort`]);

      for (const [name, input] of [
        ["tell_session", { to: strangerRoom.title, message: "hi" }],
        ["abort_session", { to: strangerRoom.title }],
      ] as const) {
        expect((await call(name, input)).isError).toBe(true);
      }
      expect(inbox(strangerRoom.id)).toEqual([]);
    } finally {
      for (const topic of [current, dual, humanRoom, strangerRoom]) {
        db.run("DELETE FROM session_inbox WHERE topic_id = ?", [topic.id]);
        db.run("DELETE FROM topic_members WHERE topic_id = ?", [topic.id]);
        db.run("DELETE FROM api_topics WHERE id = ?", [topic.id]);
      }
    }
  });

  test("with a hub grant the stdio server sends node/topic tells to the hub as a bearer call", async () => {
    const scope = `ws-stdio-hub-${randomUUID()}`;
    const current = otiumRoom(`stdio-hub-${randomUUID()}`, scope);
    const received: Array<{
      path: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    const hub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        received.push({
          path: url.pathname,
          authorization: req.headers.get("authorization"),
          body: (await req.json()) as Record<string, unknown>,
        });
        if (url.pathname.endsWith("/abort")) {
          return Response.json(
            { ok: false, v: 1, error: 'Session "worker/Nope" not found.' },
            { status: 404 },
          );
        }
        return Response.json({ ok: true, v: 1, replayed: false }, { status: 202 });
      },
    });
    const capability = "rsc1.cGF5bG9hZA.c2lnbmF0dXJl";
    try {
      const grantArg = `--remote-session-grant=${encodeRemoteSessionGrantArg({
        hubUrl: `http://127.0.0.1:${hub.port}`,
        capability,
      })}`;
      const told = await callSessionCommTool({
        title: current.title,
        topicId: current.id,
        agent: "codex",
        extraArgs: ["--actor-user-id=person", grantArg],
        name: "tell_session",
        input: { to: "worker/Render", message: "hi" },
      });
      expect(told.isError).not.toBe(true);
      expect(told.text).toContain("request_id");
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        path: "/api/v1/session-comm/remote/tell",
        authorization: `Bearer ${capability}`,
        body: {
          v: 1,
          to: { node: "worker", topic: "Render" },
          message: "hi",
          depth: 1,
          fromLabel: { key: `agent:${current.title}`, title: current.title },
        },
      });
      // No actor id in the body: the hub recovers it from the capability.
      expect(JSON.stringify(received[0]!.body)).not.toContain("person");
      const aborted = await callSessionCommTool({
        title: current.title,
        topicId: current.id,
        agent: "codex",
        extraArgs: ["--actor-user-id=person", grantArg],
        name: "abort_session",
        input: { to: "worker/Nope" },
      });
      expect(aborted.isError).toBe(true);
      expect(aborted.text).toContain("not found");
      // The same turn without the grant is the pre-existing refusal.
      const refused = await callSessionCommTool({
        title: current.title,
        topicId: current.id,
        agent: "codex",
        extraArgs: ["--actor-user-id=person"],
        name: "tell_session",
        input: { to: "worker/Render", message: "hi" },
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Otium room");
      expect(received).toHaveLength(2);
    } finally {
      hub.stop(true);
      db.run("DELETE FROM api_topics WHERE id = ?", [current.id]);
    }
  });

  test("remote node/topic targets are fail-closed on Otium and unchanged elsewhere", async () => {
    const scope = `ws-stdio-peer-${randomUUID()}`;
    const current = otiumRoom(`stdio-peer-${randomUUID()}`, scope);
    const terminal = registerTopic({
      title: `stdio-terminal-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    try {
      const refused = await callSessionCommTool({
        title: current.title,
        topicId: current.id,
        agent: "codex",
        extraArgs: [
          "--actor-user-id=person",
          `--actor-topic-scope=${encodeActorTopicScopeArg({
            visibleNodeTopicIds: [current.id],
            ownedNodeTopicIds: [current.id],
          })}`,
        ],
        name: "tell_session",
        input: { to: "peer/remote-room", message: "hi" },
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Otium room");
      // A terminal room reaches the (here: absent) bridge as before.
      const standalone = await callSessionCommTool({
        title: terminal.title,
        topicId: terminal.id,
        agent: "codex",
        name: "tell_session",
        input: { to: "peer/remote-room", message: "hi" },
      });
      expect(standalone.isError).toBe(true);
      expect(standalone.text).toContain("standalone mode");
    } finally {
      db.run("DELETE FROM api_topics WHERE id = ?", [current.id]);
      db.run("DELETE FROM api_topics WHERE id = ?", [terminal.id]);
    }
  });
});

describe("session-comm tool exposure", () => {
  test("manager rooms expose the canonical tell/ask contract", async () => {
    const general = ensurePersonalGeneral(USER_ID);
    expectCommunicationContract(
      await listSessionCommTools({
        title: general.title,
        topicId: general.id,
        agent: general.agent ?? "maestro",
      }),
    );
  });

  test("ordinary topic rooms expose the same tell/ask contract", async () => {
    const topic = registerTopic({
      title: `session-tools-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    expectCommunicationContract(
      await listSessionCommTools({
        title: topic.title,
        topicId: topic.id,
        agent: topic.agent ?? "maestro",
      }),
    );
  });

  test("ask_cron rejects topics without a run and enqueues cron-targeted asks", async () => {
    const topic = registerTopic({
      title: `ask-cron-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    const missing = await callSessionCommTool({
      title: topic.title,
      topicId: topic.id,
      agent: "codex",
      name: "ask_cron",
      input: { message: "What did the scheduled task find?" },
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("최소 한 번 실행");

    const sent = await callSessionCommTool({
      title: topic.title,
      topicId: topic.id,
      agent: "codex",
      cronSessionId: "cron-parent-session",
      name: "ask_cron",
      input: { message: "What did the scheduled task find?" },
    });
    expect(sent.isError).toBe(false);
    expect(sent.text).toContain(`${topic.title}:cron`);
    const row = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(topic.id);
    const entry = JSON.parse(row?.payload ?? "null") as {
      target?: string;
      requestId: string;
      from: string;
    };
    expect(entry.target).toBe("cron");
    db.run("DELETE FROM session_inbox WHERE topic_id = ?", [topic.id]);
    clearPendingAsk({
      userId: USER_ID,
      from: entry.from,
      to: topic.title,
      requestId: entry.requestId,
    });
  });

  test("missing topic records fail closed instead of exposing ask and abort", async () => {
    const names = await listSessionCommTools({
      title: "missing-subagent",
      topicId: `missing-${randomUUID()}`,
      subagentParentTopicId: `parent-${randomUUID()}`,
      agent: "maestro",
    });
    expect(names).toContain("tell_session");
    expect(names).not.toContain("ask_session");
    expect(names).not.toContain("ask_cron");
    expect(names).not.toContain("abort_session");
  });

  test("subagent rooms expose one-way tell but not ask", async () => {
    const parent = registerTopic({
      title: `session-parent-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    const child = registerTopic({
      title: `session-child-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    child.parentTopicId = parent.id;
    child.isSubagent = true;
    upsertTopic(child);
    const names = await listSessionCommTools({
      title: child.title,
      topicId: child.id,
      agent: child.agent ?? "maestro",
    });
    expect(names).toContain("tell_session");
    expect(names).not.toContain("ask_session");
    expect(names).not.toContain("ask_cron");

    const unrelated = registerTopic({
      title: `session-unrelated-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    const listed = await listSessionsText({
      title: child.title,
      topicId: child.id,
      agent: child.agent ?? "maestro",
    });
    expect(listed).toContain(parent.title);
    expect(listed).not.toContain(unrelated.title);
    const denied = await callSessionCommTool({
      title: child.title,
      topicId: child.id,
      agent: child.agent ?? "maestro",
      name: "tell_session",
      input: { to: unrelated.title, message: "should not pass" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("direct parent");
  });

  test("report mode controls whether a subagent can tell its parent", async () => {
    const parent = registerTopic({
      title: `report-parent-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    const tellChild = registerTopic({
      title: `report-tell-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    tellChild.parentTopicId = parent.id;
    tellChild.isSubagent = true;
    tellChild.subagentReportMode = "tell";
    upsertTopic(tellChild);

    const tellListed = await listSessionsText({
      title: tellChild.title,
      topicId: tellChild.id,
      agent: tellChild.agent ?? "codex",
    });
    expect(tellListed).toContain(parent.title);
    const delivered = await callSessionCommTool({
      title: tellChild.title,
      topicId: tellChild.id,
      agent: tellChild.agent ?? "codex",
      name: "tell_session",
      input: { to: parent.title, message: "explicit report" },
    });
    expect(delivered.isError).not.toBe(true);

    const statusOnlyChild = registerTopic({
      title: `report-status-only-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    statusOnlyChild.parentTopicId = parent.id;
    statusOnlyChild.isSubagent = true;
    statusOnlyChild.subagentReportMode = "status-only";
    upsertTopic(statusOnlyChild);

    const statusOnlyListed = await listSessionsText({
      title: statusOnlyChild.title,
      topicId: statusOnlyChild.id,
      agent: statusOnlyChild.agent ?? "codex",
    });
    expect(statusOnlyListed).not.toContain(parent.title);
    const denied = await callSessionCommTool({
      title: statusOnlyChild.title,
      topicId: statusOnlyChild.id,
      agent: statusOnlyChild.agent ?? "codex",
      name: "tell_session",
      input: { to: parent.title, message: "must stay disconnected" },
    });
    expect(denied.isError).toBe(true);
  });

  test("a nested subagent manager can tell its direct child", async () => {
    const root = registerTopic({
      title: `nested-root-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    const manager = registerTopic({
      title: `nested-manager-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    manager.parentTopicId = root.id;
    manager.isSubagent = true;
    upsertTopic(manager);
    const child = registerTopic({
      title: `nested-child-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    child.parentTopicId = manager.id;
    child.isSubagent = true;
    upsertTopic(child);

    const listed = await listSessionsText({
      title: manager.title,
      topicId: manager.id,
      agent: manager.agent ?? "maestro",
    });
    expect(listed).toContain(child.title);
    const delivered = await callSessionCommTool({
      title: manager.title,
      topicId: manager.id,
      agent: manager.agent ?? "maestro",
      name: "tell_session",
      input: { to: child.title, message: "continue" },
    });
    expect(delivered.isError).toBe(false);
  });

  test("list_sessions omits topics that tell/ask cannot address", async () => {
    const current = registerTopic({
      title: `session-current-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    const humanOnly = registerTopic({
      title: `session-human-${randomUUID()}`,
      userId: USER_ID,
      kind: "channel",
    });
    const target = registerTopic({
      title: `session-target-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });

    const listed = await listSessionsText({
      title: current.title,
      topicId: current.id,
      agent: current.agent ?? "maestro",
    });
    expect(listed).toContain(target.title);
    expect(listed).not.toContain(humanOnly.title);
    expect(listed.match(new RegExp(`^- ${target.title}:`, "gm"))).toHaveLength(1);
    expect(listed).not.toContain(`agent:${target.title}`);
  });

  test("peek_session reads ID-addressed state and lists each target once", async () => {
    const current = registerTopic({
      title: `peek-current-${randomUUID()}`,
      userId: USER_ID,
      agent: "maestro",
    });
    const target = registerTopic({
      title: `peek-target-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    writeQueryState(USER_ID, target.id, target.title, "review");
    try {
      const peeked = await peekSessionsText({
        title: current.title,
        topicId: current.id,
        agent: current.agent ?? "maestro",
      });
      expect(peeked.match(new RegExp(target.title, "g"))).toHaveLength(1);
      expect(peeked).not.toContain(`agent:${target.title}`);
    } finally {
      clearQueryState(USER_ID, target.id, target.title);
    }
  });
});
