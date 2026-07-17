import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SESSION_COMM_SERVER } from "#platform/config";
import { registerTopic } from "#topics/create";
import { ensurePersonalGeneral } from "#topics/personal-general";

const USER_ID = `session-tools-${randomUUID()}`;

async function listSessionCommTools(args: {
  title: string;
  topicId: string;
  agent: "claude" | "codex" | "maestro";
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
      "--depth=0",
      `--agent=${args.agent}`,
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

function expectCommunicationContract(names: string[]): void {
  expect(names).toEqual(
    expect.arrayContaining([
      "list_sessions",
      "peek_session",
      "tell_session",
      "ask_session",
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
  });
});
