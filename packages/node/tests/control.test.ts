import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendApiMessage,
  claimRuntimeTurnLease,
  db,
  getApiMessage,
  getApiTopicConfig,
  getTopic,
  getTopicSessionId,
  latestRuntimeEventSeq,
  listApiMessages,
  listRunningTopicQueries,
  NEGOTIUM_VERSION,
  NODE_CONTROL_TOKEN,
  registerTopic,
  releaseRuntimeTurnLease,
  runtimeBus,
  setTopicSessionId,
  upsertTopic,
  vaultDel,
  vaultListWithValues,
} from "@negotium/core";
import type { TopicDto } from "@negotium/core/node-host";
import { recordUsage } from "@negotium/core/storage";
import {
  createNodeControlHandler,
  NODE_CONTROL_BASE_PATH,
  NODE_CONTROL_PROTOCOL_VERSION,
  NODE_RUNTIME_CONTRACT_BASE_PATH,
  NODE_RUNTIME_CONTRACT_VERSION,
} from "../src/control";

const userId = `node-control-${randomUUID()}`;
const handler = createNodeControlHandler({
  port: () => 43210,
  startedAt: "2026-07-14T00:00:00.000Z",
  requestShutdown() {},
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${NODE_CONTROL_TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

function runtimeRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:43210${NODE_RUNTIME_CONTRACT_BASE_PATH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${NODE_CONTROL_TOKEN}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

test("node control API rejects missing bearer authentication", async () => {
  const response = await handler(
    new Request(`http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}/status`),
  );
  expect(response?.status).toBe(401);
});

test("runtime gateway contract rejects missing bearer authentication", async () => {
  const response = await handler(
    new Request(`http://127.0.0.1:43210${NODE_RUNTIME_CONTRACT_BASE_PATH}/health`),
  );
  expect(response?.status).toBe(401);
});

test("runtime gateway health negotiates the v1 capability set", async () => {
  const response = await handler(runtimeRequest("/health"));
  expect(await response?.json()).toMatchObject({
    ok: true,
    v: NODE_RUNTIME_CONTRACT_VERSION,
    capabilities: expect.arrayContaining([
      "turn-submit-idempotent",
      "turn-events-sse-resume",
      "canonical-topic-read",
      "canonical-message-read",
      "canonical-topic-list",
      "canonical-topic-create",
    ]),
  });
});

test("runtime gateway topic create makes a shared canonical topic", async () => {
  const createUser = `topic-create-${randomUUID()}`;
  const title = `Created ${randomUUID()}`;
  const response = await handler(
    runtimeRequest("/topics", {
      method: "POST",
      body: JSON.stringify({ v: NODE_RUNTIME_CONTRACT_VERSION, userId: createUser, title }),
    }),
  );
  const body = (await response?.json()) as { v?: number; topic?: TopicDto };

  expect(response?.status).toBe(201);
  expect(body.v).toBe(NODE_RUNTIME_CONTRACT_VERSION);
  expect(body.topic?.title).toBe(title);
  // Born shared: a host only asks for a topic when it is already surfacing the
  // room, so it must show up in the shared list without a second call.
  expect(body.topic?.accessMode).toBe("shared");
  expect(body.topic?.participants).toEqual([{ userId: createUser, role: "owner" }]);

  const listed = await handler(runtimeRequest("/topics?accessMode=shared"));
  const ids = (((await listed?.json()) as { topics?: TopicDto[] }).topics ?? []).map((t) => t.id);
  expect(ids).toContain(body.topic!.id);

  // The turn path must accept it immediately; a topic the host cannot run is
  // worse than no topic at all.
  const turn = await handler(
    runtimeRequest("/turns", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        topicId: body.topic!.id,
        userId: createUser,
        text: "hello",
        clientMessageId: `create-${randomUUID()}`,
        allowAutoContinue: false,
      }),
    }),
  );
  expect(turn?.status).toBe(202);
});

test("runtime gateway history import seeds a topic verbatim without running a turn", async () => {
  const importUser = `import-${randomUUID()}`;
  const created = await handler(
    runtimeRequest("/topics", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        userId: importUser,
        title: `Import ${randomUUID()}`,
      }),
    }),
  );
  const topicId = ((await created?.json()) as { topic: TopicDto }).topic.id;

  const older = "2026-01-01T00:00:00.000Z";
  const newer = "2026-01-02T00:00:00.000Z";
  const firstId = randomUUID();
  const response = await handler(
    runtimeRequest(`/topics/${encodeURIComponent(topicId)}/import`, {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        messages: [
          { id: firstId, authorId: importUser, text: "first", createdAt: older },
          { id: randomUUID(), authorId: "ai", text: "second", createdAt: newer },
        ],
      }),
    }),
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ ok: true, imported: 2 });
  const page = listApiMessages(topicId, { limit: 10 }).page;
  expect(page).toHaveLength(2);
  // Verbatim: the point of importing is that the room keeps its own history, so
  // ids, authors and timestamps must survive rather than being re-minted.
  expect(page[0]?.id).toBe(firstId);
  expect(page[0]?.authorId).toBe(importUser);
  expect(page[0]?.createdAt).toBe(older);
  expect(page[1]?.authorId).toBe("ai");
  // No turn was started: a running query here would mean importing a year of
  // history re-ran the agent once per message.
  expect(listRunningTopicQueries().get(topicId)).toBeUndefined();
  expect(getTopic(topicId)?.lastMessageAt).toBe(newer);
});

test("runtime gateway history import refuses a topic that already has messages", async () => {
  const importUser = `import-guard-${randomUUID()}`;
  const created = await handler(
    runtimeRequest("/topics", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        userId: importUser,
        title: `Guard ${randomUUID()}`,
      }),
    }),
  );
  const topicId = ((await created?.json()) as { topic: TopicDto }).topic.id;
  const seed = () =>
    handler(
      runtimeRequest(`/topics/${encodeURIComponent(topicId)}/import`, {
        method: "POST",
        body: JSON.stringify({
          v: NODE_RUNTIME_CONTRACT_VERSION,
          messages: [
            {
              id: randomUUID(),
              authorId: importUser,
              text: "seed",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      }),
    );

  expect((await seed())?.status).toBe(200);
  // Second call must not append, interleave or rewrite: import can only seed an
  // empty topic, so it cannot be used to forge history into a live room.
  const again = await seed();
  expect(again?.status).toBe(409);
  expect(listApiMessages(topicId, { limit: 10 }).page).toHaveLength(1);
});

test("runtime gateway history import validates version, shape and topic", async () => {
  const importUser = `import-bad-${randomUUID()}`;
  const created = await handler(
    runtimeRequest("/topics", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        userId: importUser,
        title: `Bad ${randomUUID()}`,
      }),
    }),
  );
  const topicId = ((await created?.json()) as { topic: TopicDto }).topic.id;
  const post = (path: string, payload: Record<string, unknown>) =>
    handler(runtimeRequest(path, { method: "POST", body: JSON.stringify(payload) }));
  const importPath = `/topics/${encodeURIComponent(topicId)}/import`;

  expect((await post(importPath, { v: 99, messages: [] }))?.status).toBe(400);
  expect(
    (await post(importPath, { v: NODE_RUNTIME_CONTRACT_VERSION, messages: "nope" }))?.status,
  ).toBe(400);
  expect(
    (
      await post(importPath, {
        v: NODE_RUNTIME_CONTRACT_VERSION,
        // Missing createdAt: a message without one would sort unpredictably and
        // silently claim "now" as its time.
        messages: [{ id: randomUUID(), authorId: importUser, text: "x" }],
      })
    )?.status,
  ).toBe(400);
  expect(
    (
      await post("/topics/does-not-exist/import", {
        v: NODE_RUNTIME_CONTRACT_VERSION,
        messages: [],
      })
    )?.status,
  ).toBe(404);
  expect(listApiMessages(topicId, { limit: 10 }).page).toHaveLength(0);
});

test("runtime gateway topic create rejects a bad version, agent, or missing title", async () => {
  const createUser = `topic-create-bad-${randomUUID()}`;
  const cases: [string, Record<string, unknown>][] = [
    ["unsupported v", { v: 99, userId: createUser, title: "x" }],
    ["missing title", { v: NODE_RUNTIME_CONTRACT_VERSION, userId: createUser }],
    ["missing userId", { v: NODE_RUNTIME_CONTRACT_VERSION, title: "x" }],
    [
      "unknown agent",
      { v: NODE_RUNTIME_CONTRACT_VERSION, userId: createUser, title: "x", agent: "gemini" },
    ],
  ];
  for (const [label, payload] of cases) {
    const response = await handler(
      runtimeRequest("/topics", { method: "POST", body: JSON.stringify(payload) }),
    );
    expect(response?.status, label).toBe(400);
  }
});

test("runtime gateway topic list filters by access mode", async () => {
  const listUser = `topic-list-${randomUUID()}`;
  const sharedTopic = registerTopic({
    title: `Shared ${randomUUID()}`,
    userId: listUser,
    agent: "codex",
  });
  const privateTopic = registerTopic({
    title: `Private ${randomUUID()}`,
    userId: listUser,
    agent: "codex",
  });
  await handler(
    request(`/topics/${encodeURIComponent(sharedTopic.id)}/access-mode`, {
      method: "POST",
      body: JSON.stringify({ userId: listUser, accessMode: "shared" }),
    }),
  );

  const sharedResponse = await handler(runtimeRequest("/topics?accessMode=shared"));
  const sharedBody = (await sharedResponse?.json()) as {
    v?: number;
    topics?: { id: string; accessMode?: string }[];
  };
  expect(sharedResponse?.status).toBe(200);
  expect(sharedBody.v).toBe(NODE_RUNTIME_CONTRACT_VERSION);
  const sharedIds = (sharedBody.topics ?? []).map((topic) => topic.id);
  expect(sharedIds).toContain(sharedTopic.id);
  expect(sharedIds).not.toContain(privateTopic.id);
  // A shared filter that leaked a private room would publish rooms the owner
  // never consented to surface, so assert the whole page, not just our two.
  expect((sharedBody.topics ?? []).every((topic) => topic.accessMode === "shared")).toBe(true);

  const privateResponse = await handler(runtimeRequest("/topics?accessMode=private"));
  const privateIds = (
    ((await privateResponse?.json()) as { topics?: { id: string }[] }).topics ?? []
  ).map((topic) => topic.id);
  expect(privateIds).toContain(privateTopic.id);
  expect(privateIds).not.toContain(sharedTopic.id);
});

test("runtime gateway topic list rejects an unknown access mode", async () => {
  const response = await handler(runtimeRequest("/topics?accessMode=everyone"));
  expect(response?.status).toBe(400);
});

test("runtime gateway accepts durably, deduplicates client messages, and streams ordered events", async () => {
  const gatewayUser = `runtime-gateway-${randomUUID()}`;
  const topic = registerTopic({
    title: `Gateway ${randomUUID()}`,
    userId: gatewayUser,
    agent: "codex",
  });
  const clientMessageId = randomUUID();
  const requestId = randomUUID();
  const cursor = latestRuntimeEventSeq();
  const events = await handler(runtimeRequest(`/events?after=${cursor}&topicId=${topic.id}`));
  const reader = events?.body?.getReader();
  await reader?.read(); // ready

  const accepted = await handler(
    runtimeRequest("/turns", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        topicId: topic.id,
        userId: gatewayUser,
        text: "durable before execution",
        clientMessageId,
        requestId,
      }),
    }),
  );
  expect(accepted?.status).toBe(202);
  const acceptedBody = (await accepted?.json()) as {
    accepted: boolean;
    deduplicated: boolean;
    messageId: string;
    cursor: number;
  };
  expect(acceptedBody).toMatchObject({ accepted: true, deduplicated: false });
  // The handler has no turn worker. A 202 therefore proves acknowledgement is
  // not delayed on agent placement or execution.
  expect(getApiMessage(topic.id, acceptedBody.messageId)?.text).toBe("durable before execution");
  expect(acceptedBody.cursor).toBeGreaterThan(cursor);

  const duplicate = await handler(
    runtimeRequest("/turns", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        topicId: topic.id,
        userId: gatewayUser,
        text: "durable before execution",
        clientMessageId,
        requestId,
      }),
    }),
  );
  expect(await duplicate?.json()).toMatchObject({
    accepted: true,
    deduplicated: true,
    messageId: acceptedBody.messageId,
    cursor: acceptedBody.cursor,
  });
  // This handler-level test intentionally has no durable worker. Remove the
  // pending request before other storage tests contend for the shared queue.
  db.query("DELETE FROM runtime_user_turn_requests WHERE topic_id = ?").run(topic.id);

  const chunks: string[] = [];
  for (
    let index = 0;
    index < 8 &&
    (chunks.join("").indexOf("turn_accepted") < 0 ||
      chunks.join("").indexOf("durable before execution") < 0);
    index += 1
  ) {
    const item = await reader?.read();
    if (item?.value) chunks.push(new TextDecoder().decode(item.value));
  }
  const stream = chunks.join("");
  expect(stream).toContain('"kind":"turn_accepted"');
  expect(stream.indexOf('"kind":"turn_accepted"')).toBeLessThan(
    stream.indexOf('"text":"durable before execution"'),
  );
  expect(stream).toContain(`id: ${acceptedBody.cursor}`);
  await reader?.cancel();

  const topicResponse = await handler(runtimeRequest(`/topics/${encodeURIComponent(topic.id)}`));
  expect(await topicResponse?.json()).toMatchObject({ ok: true, v: 1, topic: { id: topic.id } });
  const messagesResponse = await handler(
    runtimeRequest(`/topics/${encodeURIComponent(topic.id)}/messages`),
  );
  const messages = (await messagesResponse?.json()) as { page: Array<{ id: string }> };
  expect(messages.page.filter((message) => message.id === acceptedBody.messageId)).toHaveLength(1);

  // Terminal's pre-existing control routes see the same canonical topic and
  // transcript; the gateway did not create a parallel conversation path.
  const terminalTopics = await handler(request(`/topics?user=${encodeURIComponent(gatewayUser)}`));
  expect(await terminalTopics?.json()).toMatchObject({ topics: [{ id: topic.id }] });
  const terminalMessages = await handler(
    request(
      `/topics/${encodeURIComponent(topic.id)}/messages?user=${encodeURIComponent(gatewayUser)}`,
    ),
  );
  expect(await terminalMessages?.json()).toMatchObject({
    messages: [{ id: acceptedBody.messageId, text: "durable before execution" }],
  });
});

test("runtime gateway rejects a user who is not a topic participant", async () => {
  const owner = `runtime-owner-${randomUUID()}`;
  const topic = registerTopic({ title: `Gateway membership ${randomUUID()}`, userId: owner });
  const response = await handler(
    runtimeRequest("/turns", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        topicId: topic.id,
        userId: `outsider-${randomUUID()}`,
        text: "must not persist",
        clientMessageId: randomUUID(),
      }),
    }),
  );

  expect(response?.status).toBe(404);
});

test("node control executes Vault commands for the requested user without returning secrets", async () => {
  const vaultUser = `node-control-vault-${randomUUID()}`;
  const otherUser = `node-control-vault-other-${randomUUID()}`;
  const key = "REMOTE_TOKEN";
  const secret = `secret-${randomUUID()}`;

  try {
    const stored = await handler(
      request("/vault/command", {
        method: "POST",
        body: JSON.stringify({
          userId: vaultUser,
          commandLine: `/vault set ${key} ${secret} remote credential`,
        }),
      }),
    );
    expect(stored?.status).toBe(200);
    const storedText = await stored!.text();
    expect(storedText).toContain(`Stored ${key}.`);
    expect(storedText).not.toContain(secret);
    expect(vaultListWithValues(vaultUser).find((entry) => entry.key === key)?.value).toBe(secret);
    expect(vaultListWithValues(otherUser).find((entry) => entry.key === key)).toBeUndefined();

    const listed = await handler(
      request("/vault/command", {
        method: "POST",
        body: JSON.stringify({ userId: vaultUser, commandLine: "/vault list" }),
      }),
    );
    const listedText = await listed!.text();
    expect(listedText).toContain(`${key}: remote credential`);
    expect(listedText).not.toContain(secret);
  } finally {
    vaultDel(vaultUser, key);
    vaultDel(otherUser, key);
  }
});

test("node control exposes structured Vault management without returning values", async () => {
  const vaultUser = `node-control-vault-ui-${randomUUID()}`;
  const key = "UI_TOKEN";
  const secret = `secret | with spaces | ${randomUUID()}`;

  try {
    const stored = await handler(
      request("/vault", {
        method: "POST",
        body: JSON.stringify({ userId: vaultUser, key, value: secret, description: "UI test" }),
      }),
    );
    expect(stored?.status).toBe(200);
    const storedText = await stored!.text();
    expect(storedText).toContain(`"key":"${key}"`);
    expect(storedText).not.toContain(secret);

    const listed = await handler(request(`/vault?user=${encodeURIComponent(vaultUser)}`));
    const listedText = await listed!.text();
    expect(listedText).toContain(`"description":"UI test"`);
    expect(listedText).not.toContain(secret);
    expect(vaultListWithValues(vaultUser).find((entry) => entry.key === key)?.value).toBe(secret);

    const deleted = await handler(
      request(`/vault?user=${encodeURIComponent(vaultUser)}&key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      }),
    );
    expect(await deleted!.json()).toMatchObject({ ok: true, deleted: true });
  } finally {
    vaultDel(vaultUser, key);
  }
});

test("node control session, topic routes, and SSE use one versioned boundary", async () => {
  const status = await handler(request("/status"));
  expect(status?.status).toBe(200);
  const statusBody = (await status?.json()) as { protocolVersion: number; nodeVersion: string };
  expect(statusBody.protocolVersion).toBe(NODE_CONTROL_PROTOCOL_VERSION);
  expect(statusBody.nodeVersion).toBe(NEGOTIUM_VERSION);

  const session = await handler(request(`/session?user=${encodeURIComponent(userId)}`));
  const sessionBody = (await session?.json()) as {
    protocolVersion: number;
    topics: Array<{ title: string }>;
    cursor: number;
  };
  expect(sessionBody.protocolVersion).toBe(NODE_CONTROL_PROTOCOL_VERSION);
  expect(sessionBody.topics.some((topic) => topic.title === "General")).toBe(true);

  const title = `Control ${randomUUID()}`;
  const created = await handler(
    request("/topics", {
      method: "POST",
      body: JSON.stringify({ userId, title, agent: "codex" }),
    }),
  );
  expect(created?.status).toBe(201);
  const createdBody = (await created?.json()) as { topic: { id: string } };

  setTopicSessionId(createdBody.topic.id, "node-control-session", {
    reason: "test",
    agent: "codex",
  });
  const reset = await handler(
    request(`/topics/${encodeURIComponent(createdBody.topic.id)}/session/reset`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  );
  expect(reset?.status).toBe(200);
  expect(getTopicSessionId(createdBody.topic.id)).toBeNull();

  const topics = await handler(request(`/topics?user=${encodeURIComponent(userId)}`));
  const topicBody = (await topics?.json()) as { topics: Array<{ title: string }> };
  expect(topicBody.topics.some((topic) => topic.title === title)).toBe(true);

  const events = await handler(
    request(`/events?user=${encodeURIComponent(userId)}&after=${sessionBody.cursor}`),
  );
  expect(events?.headers.get("content-type")).toContain("text/event-stream");
  const reader = events?.body?.getReader();
  const first = await reader?.read();
  expect(new TextDecoder().decode(first?.value)).toContain("event: ready");
  await reader?.cancel();
});

test("background session route exposes only the requesting user's active Cron turns", async () => {
  const topic = registerTopic({ title: `Cron ${randomUUID()}`, userId, agent: "codex" });
  const hidden = registerTopic({
    title: `Other Cron ${randomUUID()}`,
    userId: `other-${randomUUID()}`,
    agent: "codex",
  });
  const queryId = randomUUID();
  const hiddenQueryId = randomUUID();
  claimRuntimeTurnLease({
    topicId: topic.id,
    queryId,
    origin: `cron:job:${randomUUID()}`,
  });
  claimRuntimeTurnLease({
    topicId: hidden.id,
    queryId: hiddenQueryId,
    origin: `cron:job:${randomUUID()}`,
  });
  try {
    const response = await handler(
      request(`/background-sessions?user=${encodeURIComponent(userId)}`),
    );
    const body = (await response?.json()) as {
      sessions: Array<{ id: string; topicId?: string; kind: string }>;
    };
    expect(response?.status).toBe(200);
    expect(body.sessions).toContainEqual(
      expect.objectContaining({ id: `cron:${queryId}`, topicId: topic.id, kind: "cron" }),
    );
    expect(body.sessions.some((session) => session.topicId === hidden.id)).toBe(false);
  } finally {
    releaseRuntimeTurnLease(topic.id, queryId);
    releaseRuntimeTurnLease(hidden.id, hiddenQueryId);
  }
});

test("topic usage route returns exact totals only to a participant", async () => {
  const topic = registerTopic({ title: `Usage ${randomUUID()}`, userId, agent: "codex" });
  recordUsage(
    userId,
    topic.title,
    { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 20, costUsd: 0.5 },
    { topicId: topic.id, agent: "codex", model: "gpt-5.6-luna" },
  );

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/usage?user=${encodeURIComponent(userId)}`),
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    ok: true,
    usage: {
      topicId: topic.id,
      inputTokens: 100,
      outputTokens: 30,
      cacheReadInputTokens: 20,
      queries: 1,
      estimatedCostUsd: 0.5,
    },
  });

  const forbidden = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/usage?user=not-a-participant`),
  );
  expect(forbidden?.status).toBe(404);
});

test("POST message broadcasts the persisted user message to peer Terminal clients", async () => {
  const localHandler = createNodeControlHandler({
    port: () => 43210,
    startedAt: "2026-07-14T00:00:00.000Z",
    requestShutdown() {},
    startTurn: () => null,
  });
  const title = `Broadcast ${randomUUID()}`;
  const created = await localHandler(
    request("/topics", {
      method: "POST",
      body: JSON.stringify({ userId, title, agent: "codex" }),
    }),
  );
  const topic = ((await created?.json()) as { topic: { id: string } }).topic;
  const seen: Array<{ text: string; sourceAdapter?: string }> = [];
  const unsubscribe = runtimeBus().subscribe((event) => {
    if (event.type === "message" && event.topicId === topic.id) {
      seen.push(event.payload as { text: string; sourceAdapter?: string });
    }
  });

  try {
    const response = await localHandler(
      request(`/topics/${encodeURIComponent(topic.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          userId,
          text: "visible in every terminal",
          sourceAdapter: "telegram",
        }),
      }),
    );
    expect(response?.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      text: "visible in every terminal",
      sourceAdapter: "telegram",
    });
  } finally {
    unsubscribe();
  }
});

test("POST model applies a picker selection without a public agent argument", async () => {
  const topic = registerTopic({
    title: `Model ${randomUUID()}`,
    userId,
    agent: "codex",
  });

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/model`, {
      method: "POST",
      body: JSON.stringify({ userId, model: "gpt-5.6-sol" }),
    }),
  );
  const body = (await response?.json()) as { model?: string; result?: string };

  expect(response?.status).toBe(200);
  expect(body.model).toBe("gpt-5.6-sol");
  expect(body.result).not.toContain("codex");
  expect(getApiTopicConfig(topic.id)).toMatchObject({
    model: "gpt-5.6-sol",
    agentLocked: true,
    modelLocked: true,
  });
});

test("POST effort applies and locks a picker selection", async () => {
  const topic = registerTopic({
    title: `Effort ${randomUUID()}`,
    userId,
    agent: "codex",
  });

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/effort`, {
      method: "POST",
      body: JSON.stringify({ userId, effort: "xhigh" }),
    }),
  );
  const body = (await response?.json()) as { effort?: string; result?: string };

  expect(response?.status).toBe(200);
  expect(body.effort).toBe("xhigh");
  expect(body.result).toBe("Effort set to 'xhigh'. Applies from the next turn.");
  expect(getApiTopicConfig(topic.id)).toMatchObject({
    effort: "xhigh",
    effortLocked: true,
  });
});

test("POST access-mode changes topic privacy for its owner", async () => {
  const topic = registerTopic({
    title: `Privacy ${randomUUID()}`,
    userId,
    agent: "codex",
  });

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/access-mode`, {
      method: "POST",
      body: JSON.stringify({ userId, accessMode: "shared" }),
    }),
  );
  const body = (await response?.json()) as { accessMode?: string };

  expect(response?.status).toBe(200);
  expect(body.accessMode).toBe("shared");
  expect(getTopic(topic.id)?.accessMode).toBe("shared");
});

test("message history pages backward from the latest messages", async () => {
  const topic = registerTopic({
    title: `History ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  for (let index = 0; index < 55; index += 1) {
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: userId,
      text: `history-${index}`,
      createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    });
  }

  const latest = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/messages?user=${userId}&limit=20`),
  );
  const latestBody = (await latest?.json()) as {
    messages: Array<{ id: string; text: string }>;
    cursor: string;
    hasMore: boolean;
  };
  expect(latestBody.messages.map((message) => message.text)).toEqual(
    Array.from({ length: 20 }, (_, index) => `history-${index + 35}`),
  );
  expect(latestBody.hasMore).toBe(true);

  const older = await handler(
    request(
      `/topics/${encodeURIComponent(topic.id)}/messages?user=${userId}&limit=20&cursor=${encodeURIComponent(latestBody.cursor)}`,
    ),
  );
  const olderBody = (await older?.json()) as {
    messages: Array<{ text: string }>;
    hasMore: boolean;
  };
  expect(olderBody.messages.map((message) => message.text)).toEqual(
    Array.from({ length: 20 }, (_, index) => `history-${index + 15}`),
  );
  expect(olderBody.hasMore).toBe(true);
});

test("POST compact delegates session rotation for an owned topic", async () => {
  const calls: Array<{ topicId: string; userId: string }> = [];
  const localHandler = createNodeControlHandler({
    port: () => 43210,
    startedAt: "2026-07-14T00:00:00.000Z",
    requestShutdown() {},
    compactSession: async (topicId, compactUserId) => {
      calls.push({ topicId, userId: compactUserId });
      return { text: "compacted" };
    },
  });
  const topic = registerTopic({
    title: `Compact ${randomUUID()}`,
    userId,
    agent: "codex",
  });

  const response = await localHandler(
    request(`/topics/${encodeURIComponent(topic.id)}/session/compact`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  );
  expect(response?.status).toBe(200);
  expect(calls).toEqual([{ topicId: topic.id, userId }]);
});

test("POST derive spawns a config-only copy without the source history", async () => {
  const topic = registerTopic({ title: `Derive ${randomUUID()}`, userId });
  const name = `Derive spawn ${randomUUID()}`;

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/derive`, {
      method: "POST",
      body: JSON.stringify({ userId, copyHistory: false, name }),
    }),
  );
  expect(response?.status).toBe(201);
  const body = (await response?.json()) as {
    topic: { id: string; title: string; isFork: boolean };
  };
  expect(body.topic.title).toBe(name);
  expect(body.topic.isFork).toBe(false);
});

test("POST derive rejects a name that collides with an existing topic", async () => {
  const topic = registerTopic({ title: `Derive conflict ${randomUUID()}`, userId });
  const conflictingTitle = `Derive taken ${randomUUID()}`;
  registerTopic({ title: conflictingTitle, userId });

  const response = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/derive`, {
      method: "POST",
      body: JSON.stringify({ userId, copyHistory: true, name: conflictingTitle }),
    }),
  );
  expect(response?.status).toBe(409);
});

test("POST derive validates mode and membership while allowing an active source snapshot", async () => {
  const topic = registerTopic({ title: `Derive guarded ${randomUUID()}`, userId });

  const malformed = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/derive`, {
      method: "POST",
      body: JSON.stringify({ userId, copyHistory: "yes" }),
    }),
  );
  expect(malformed?.status).toBe(400);

  const forbidden = await handler(
    request(`/topics/${encodeURIComponent(topic.id)}/derive`, {
      method: "POST",
      body: JSON.stringify({ userId: `other-${randomUUID()}`, copyHistory: false }),
    }),
  );
  expect(forbidden?.status).toBe(404);

  const queryId = randomUUID();
  claimRuntimeTurnLease({ topicId: topic.id, queryId, origin: "user" });
  try {
    const derived = await handler(
      request(`/topics/${encodeURIComponent(topic.id)}/derive`, {
        method: "POST",
        body: JSON.stringify({ userId, copyHistory: true }),
      }),
    );
    expect(derived?.status).toBe(201);
    const body = (await derived?.json()) as { topic: { id: string; isFork: boolean } };
    expect(body.topic.id).not.toBe(topic.id);
    expect(body.topic.isFork).toBe(true);
  } finally {
    releaseRuntimeTurnLease(topic.id, queryId);
  }
});

test("an open SSE stream stops exposing a topic after participant removal", async () => {
  const member = `revoked-${randomUUID()}`;
  const topic = registerTopic({ title: `Revoked ${randomUUID()}`, userId: member, agent: "codex" });
  const after = latestRuntimeEventSeq();
  const response = await handler(
    request(`/events?user=${encodeURIComponent(member)}&after=${after}`),
  );
  const reader = response?.body?.getReader();

  try {
    const ready = await reader?.read();
    expect(new TextDecoder().decode(ready?.value)).toContain("event: ready");

    upsertTopic({
      ...topic,
      participants: [{ userId: `replacement-${randomUUID()}`, role: "owner" }],
    });
    runtimeBus().broadcastTopicUpdated(topic.id);
    runtimeBus().broadcastMessage(topic.id, {
      id: randomUUID(),
      topicId: topic.id,
      authorId: "ai",
      text: "must stay hidden after revocation",
      createdAt: new Date().toISOString(),
    });

    const update = await reader?.read();
    const payload = new TextDecoder().decode(update?.value);
    expect(payload).toContain("event: cursor");
    expect(payload).not.toContain("must stay hidden after revocation");
  } finally {
    await reader?.cancel();
  }
});
