import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SESSION_COMM_SERVER } from "#platform/config";
import { clearQueryState, writeQueryState } from "#query/state";
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
