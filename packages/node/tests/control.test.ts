import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendApiMessage,
  claimRuntimeTurnLease,
  getApiTopicConfig,
  getTopicSessionId,
  latestRuntimeEventSeq,
  NODE_CONTROL_TOKEN,
  registerTopic,
  releaseRuntimeTurnLease,
  runtimeBus,
  setTopicSessionId,
  upsertTopic,
} from "@negotium/core";
import {
  createNodeControlHandler,
  NODE_CONTROL_BASE_PATH,
  NODE_CONTROL_PROTOCOL_VERSION,
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

test("node control API rejects missing bearer authentication", async () => {
  const response = await handler(
    new Request(`http://127.0.0.1:43210${NODE_CONTROL_BASE_PATH}/status`),
  );
  expect(response?.status).toBe(401);
});

test("node control session, topic routes, and SSE use one versioned boundary", async () => {
  const status = await handler(request("/status"));
  expect(status?.status).toBe(200);
  const statusBody = (await status?.json()) as { protocolVersion: number };
  expect(statusBody.protocolVersion).toBe(NODE_CONTROL_PROTOCOL_VERSION);

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
      sourceAdapter: "terminal",
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

test("POST derive validates mode, membership, and active source state", async () => {
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
    const busy = await handler(
      request(`/topics/${encodeURIComponent(topic.id)}/derive`, {
        method: "POST",
        body: JSON.stringify({ userId, copyHistory: true }),
      }),
    );
    expect(busy?.status).toBe(409);
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
