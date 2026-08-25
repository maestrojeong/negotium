import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  getDecisionFilePath,
  getDecisionGraphSvgPath,
  recordUsage,
  writeDecisions,
} from "@negotium/core/storage";
import { CRON_JOBS_DIR } from "@negotium/module-cron";
import {
  createNodeControlHandler,
  NODE_CONTROL_BASE_PATH,
  NODE_CONTROL_PROTOCOL_VERSION,
  NODE_RUNTIME_CONTRACT_BASE_PATH,
  NODE_RUNTIME_CONTRACT_VERSION,
  NODE_RUNTIME_SURFACE_SCOPE_HEADER,
  NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER,
} from "../src/control";
import { nodeFileStore } from "../src/files";

/** The principal every mapped room executes as. */
const NODE_EXECUTION_PRINCIPAL_FOR_TEST = "local";

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
      "canonical-topic-usage",
      "canonical-file-read",
      "canonical-visual-read",
      "canonical-topic-list",
      "canonical-topic-create",
      "canonical-manager-topic",
    ]),
  });
});

test("runtime gateway ensures one private manager topic per external user", async () => {
  const managerUser = `manager-${randomUUID()}`;
  const ensure = () =>
    handler(
      runtimeRequest("/manager-topic", {
        method: "POST",
        body: JSON.stringify({ v: NODE_RUNTIME_CONTRACT_VERSION, userId: managerUser }),
      }),
    );

  const first = await ensure();
  const firstBody = (await first?.json()) as { topic?: TopicDto };
  const second = await ensure();
  const secondBody = (await second?.json()) as { topic?: TopicDto };

  expect(first?.status).toBe(200);
  expect(firstBody.topic).toMatchObject({
    title: "General",
    kind: "manager",
    agent: "maestro",
    participants: [{ userId: managerUser, role: "owner" }],
    surface: "otium",
  });
  expect(secondBody.topic?.id).toBe(firstBody.topic?.id);

  const turn = await handler(
    runtimeRequest("/turns", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        topicId: firstBody.topic?.id,
        userId: managerUser,
        text: "manage my workspace",
        clientMessageId: `manager-${randomUUID()}`,
        allowAutoContinue: false,
      }),
    }),
  );
  expect(turn?.status).toBe(202);
});

test("runtime gateway keeps Cron execution and actor ownership separate", async () => {
  const principal = `cron-principal-${randomUUID()}`;
  const topic = registerTopic({
    title: `Cron actor ${randomUUID()}`,
    userId: principal,
    agent: "codex",
    surface: "otium",
  });
  const script = `gateway-${randomUUID()}.py`;
  const scriptPath = join(CRON_JOBS_DIR, script);
  mkdirSync(CRON_JOBS_DIR, { recursive: true });
  writeFileSync(scriptPath, "print('ok')");
  const name = `same-name-${randomUUID()}`;
  const create = async (actorUserId: string) =>
    handler(
      runtimeRequest("/cron/jobs", {
        method: "POST",
        body: JSON.stringify({
          v: NODE_RUNTIME_CONTRACT_VERSION,
          userId: principal,
          actorUserId,
          topicId: topic.id,
          name,
          script,
          schedule: "*/5 * * * *",
          timezone: "UTC",
        }),
      }),
    );
  try {
    const first = await create("product-a");
    const firstJob = (await first?.json()) as {
      job?: { id: string; executionPrincipalUserId: string; actorOwnerUserId: string };
    };
    const second = await create("product-b");
    expect(first?.status).toBe(201);
    expect(second?.status).toBe(201);
    expect(firstJob.job).toMatchObject({
      executionPrincipalUserId: principal,
      actorOwnerUserId: "product-a",
    });

    const own = await handler(
      runtimeRequest(`/cron/jobs?user=${principal}&actorUserId=product-a&actorIsAdmin=0`),
    );
    expect(((await own?.json()) as { jobs?: Array<{ id: string }> }).jobs).toEqual([
      expect.objectContaining({ id: firstJob.job?.id }),
    ]);

    const denied = await handler(
      runtimeRequest(`/cron/jobs/${firstJob.job?.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          v: NODE_RUNTIME_CONTRACT_VERSION,
          userId: principal,
          actorUserId: "product-b",
          patch: { enabled: false },
        }),
      }),
    );
    expect(denied?.status).toBe(403);
    const updated = await handler(
      runtimeRequest(`/cron/jobs/${firstJob.job?.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          v: NODE_RUNTIME_CONTRACT_VERSION,
          userId: principal,
          actorUserId: "product-a",
          patch: { enabled: false },
        }),
      }),
    );
    expect((await updated?.json()) as { job?: { enabled: boolean } }).toMatchObject({
      job: { enabled: false },
    });
    const deleted = await handler(
      runtimeRequest(
        `/cron/jobs/${firstJob.job?.id}?user=${principal}&actorUserId=product-a&actorIsAdmin=0`,
        { method: "DELETE" },
      ),
    );
    expect(deleted?.status).toBe(200);
  } finally {
    unlinkSync(scriptPath);
  }
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
  // Born on the otium surface: a host only asks for a topic when it is already
  // surfacing the room, so it must show up in the list without a second call.
  expect(body.topic?.surface).toBe("otium");
  expect(body.topic?.participants).toEqual([{ userId: createUser, role: "owner" }]);

  const listed = await handler(runtimeRequest("/topics"));
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

/**
 * The capability was advertised while the route lived only on the control
 * surface, so a host feature-detected support and got a 404 from the contract
 * dispatcher — forking a room in Otium failed, and rooms derived before the
 * refusal existed only in the hub's store.
 */
test("runtime gateway topic derive forks the room the contract advertises", async () => {
  const deriveUser = `topic-derive-${randomUUID()}`;
  const created = await handler(
    runtimeRequest("/topics", {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        userId: deriveUser,
        title: `Derive source ${randomUUID()}`,
      }),
    }),
  );
  const source = ((await created?.json()) as { topic: TopicDto }).topic;

  const health = await handler(runtimeRequest("/health"));
  const capabilities = ((await health?.json()) as { capabilities?: string[] }).capabilities ?? [];
  expect(capabilities).toContain("canonical-topic-derive");

  const name = `Derived ${randomUUID()}`;
  const response = await handler(
    runtimeRequest(`/topics/${encodeURIComponent(source.id)}/derive`, {
      method: "POST",
      body: JSON.stringify({
        v: NODE_RUNTIME_CONTRACT_VERSION,
        userId: deriveUser,
        copyHistory: false,
        name,
      }),
    }),
  );
  const body = (await response?.json()) as { v?: number; topic?: TopicDto };
  expect(response?.status).toBe(201);
  expect(body.v).toBe(NODE_RUNTIME_CONTRACT_VERSION);
  expect(body.topic?.title).toBe(name);
  expect(body.topic?.parentTopicId).toBe(source.id);
  // Derived on the node means the canonical list holds it too; a room the
  // node does not know is a room only the hub can run.
  const listed = await handler(runtimeRequest("/topics"));
  const ids = (((await listed?.json()) as { topics?: TopicDto[] }).topics ?? []).map((t) => t.id);
  expect(ids).toContain(body.topic!.id);
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

test("runtime gateway topic list exposes only the otium surface", async () => {
  const listUser = `topic-list-${randomUUID()}`;
  const hubTopic = registerTopic({
    title: `Hub ${randomUUID()}`,
    userId: listUser,
    agent: "codex",
    surface: "otium",
  });
  const terminalTopic = registerTopic({
    title: `Local ${randomUUID()}`,
    userId: listUser,
    agent: "codex",
    surface: "terminal",
  });

  const response = await handler(runtimeRequest("/topics"));
  const body = (await response?.json()) as {
    v?: number;
    topics?: { id: string; surface?: string }[];
  };
  expect(response?.status).toBe(200);
  expect(body.v).toBe(NODE_RUNTIME_CONTRACT_VERSION);
  const ids = (body.topics ?? []).map((topic) => topic.id);
  expect(ids).toContain(hubTopic.id);
  expect(ids).not.toContain(terminalTopic.id);
  // A leak here would hand the hub rooms that live on another surface, so
  // assert the whole page rather than just the two rooms this test made.
  expect((body.topics ?? []).every((topic) => topic.surface === "otium")).toBe(true);
});

test("runtime gateway topic list carries the last message preview and time", async () => {
  const listUser = `topic-preview-${randomUUID()}`;
  const make = (title: string) =>
    registerTopic({ title: `${title} ${randomUUID()}`, userId: listUser, surface: "otium" });

  const chatty = make("Chatty");
  const silent = make("Silent");
  const tombstoned = make("Tombstoned");
  const onlyTombstone = make("OnlyTombstone");

  // `last_message_at` only ever moves forward and the row is seeded at creation
  // time, so the fixtures have to be stamped after the topics exist for the
  // timestamp assertion to mean anything.
  const stamp = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const chattyAt = stamp(1_000);
  appendApiMessage({
    id: randomUUID(),
    topicId: chatty.id,
    authorId: listUser,
    text: "  first\nline   of\ttalk  ",
    createdAt: chattyAt,
  });
  appendApiMessage({
    id: randomUUID(),
    topicId: tombstoned.id,
    authorId: listUser,
    text: "survivor",
    createdAt: stamp(2_000),
  });
  // A tombstone is the newest row in the topic, so it would win the "latest
  // message" race if the query did not exclude deleted rows.
  appendApiMessage({
    id: randomUUID(),
    topicId: tombstoned.id,
    authorId: listUser,
    text: "",
    deleted: true,
    createdAt: stamp(3_000),
  });
  appendApiMessage({
    id: randomUUID(),
    topicId: onlyTombstone.id,
    authorId: listUser,
    text: "",
    deleted: true,
    createdAt: stamp(3_000),
  });

  const response = await handler(runtimeRequest("/topics"));
  const body = (await response?.json()) as {
    topics?: { id: string; lastMessagePreview?: string; lastMessageAt?: string }[];
  };
  const byId = new Map((body.topics ?? []).map((topic) => [topic.id, topic]));

  // Whitespace collapsing comes from the shared preview derivation, so asserting
  // it here keeps this surface pinned to the same rendering the UI list uses.
  expect(byId.get(chatty.id)?.lastMessagePreview).toBe("first line of talk");
  expect(byId.get(chatty.id)?.lastMessageAt).toBe(chattyAt);
  expect(byId.get(tombstoned.id)?.lastMessagePreview).toBe("survivor");
  // The field is absent, not empty: the host falls back to its own value only
  // when it can see nothing was sent.
  expect(byId.get(silent.id)).not.toHaveProperty("lastMessagePreview");
  expect(byId.get(onlyTombstone.id)).not.toHaveProperty("lastMessagePreview");
});

test("runtime gateway topic list is scoped to the caller's workspace", async () => {
  const listUser = `topic-scope-${randomUUID()}`;
  const make = (surfaceScope: string | null) =>
    registerTopic({
      title: `Scoped ${randomUUID()}`,
      userId: listUser,
      agent: "codex",
      surface: "otium",
      surfaceScope,
    });
  const alpha = make("ws_alpha");
  const beta = make("ws_beta");
  const unscoped = make(null);

  const list = async (scope?: string) => {
    const response = await handler(
      runtimeRequest("/topics", {
        ...(scope === undefined ? {} : { headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: scope } }),
      }),
    );
    const body = (await response?.json()) as { topics?: { id: string }[] };
    return (body.topics ?? []).map((topic) => topic.id);
  };

  const forAlpha = await list("ws_alpha");
  expect(forAlpha).toContain(alpha.id);
  // A leak here would hand one workspace's hub the rooms of another, which is
  // the entire security argument for multi-workspace join.
  expect(forAlpha).not.toContain(beta.id);
  // Without the strict flag this node serves a single workspace, so an unscoped
  // room is legacy rather than ambiguous and stays visible.
  expect(forAlpha).toContain(unscoped.id);

  // An unresolved workspace sees the unscoped rooms, not everything.
  const forUnresolved = await list("");
  expect(forUnresolved).toContain(unscoped.id);
  expect(forUnresolved).not.toContain(alpha.id);

  // No header at all is a loopback hub, which keeps the whole surface.
  const forLoopback = await list();
  expect(forLoopback).toEqual(expect.arrayContaining([alpha.id, beta.id, unscoped.id]));
});

test("unfiltered runtime events expose only the Otium surface", async () => {
  const user = `event-surface-${randomUUID()}`;
  const controller = new AbortController();
  const after = latestRuntimeEventSeq();
  const response = await handler(
    runtimeRequest(`/events?after=${after}`, { signal: controller.signal }),
  );
  const reader = response!.body!.getReader();
  const decoder = new TextDecoder();
  // Consume the ready frame before adding events to the runtime bus.
  await reader.read();

  const terminal = registerTopic({
    title: `Terminal ${randomUUID()}`,
    userId: user,
    agent: "codex",
    surface: "terminal",
  });
  const otium = registerTopic({
    title: `Otium ${randomUUID()}`,
    userId: user,
    agent: "codex",
    surface: "otium",
  });

  let received = "";
  for (let reads = 0; reads < 4 && !received.includes(otium.id); reads += 1) {
    const next = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for Otium event")), 1_000),
      ),
    ]);
    received += decoder.decode(next.value);
  }
  controller.abort();
  await reader.cancel();

  expect(received).toContain(otium.id);
  expect(received).not.toContain(terminal.id);
});

test("an unscoped room is legacy for one workspace and ambiguous for several", async () => {
  const user = `topic-scope-strict-${randomUUID()}`;
  const legacy = registerTopic({
    title: `Legacy ${randomUUID()}`,
    userId: user,
    agent: "codex",
    surface: "otium",
    surfaceScope: null,
  });
  const ask = async (strict: boolean) => {
    const listed = await handler(
      runtimeRequest("/topics", {
        headers: {
          [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws_alpha",
          [NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER]: strict ? "1" : "0",
        },
      }),
    );
    const body = (await listed?.json()) as { topics?: { id: string }[] };
    const direct = await handler(
      runtimeRequest(`/topics/${legacy.id}`, {
        headers: {
          [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws_alpha",
          [NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER]: strict ? "1" : "0",
        },
      }),
    );
    return { listed: (body.topics ?? []).map((t) => t.id), status: direct?.status };
  };

  // One workspace attached: the room predates the column and must stay usable.
  const lenient = await ask(false);
  expect(lenient.listed).toContain(legacy.id);
  expect(lenient.status).toBe(200);

  // Several attached: it belongs to none of them, so it belongs to none.
  const strict = await ask(true);
  expect(strict.listed).not.toContain(legacy.id);
  expect(strict.status).toBe(404);
});

test("strict runtime SSE does not expose events from an unscoped legacy room", async () => {
  const user = `strict-sse-${randomUUID()}`;
  const legacy = registerTopic({
    title: `Strict SSE legacy ${randomUUID()}`,
    userId: user,
    surface: "otium",
    surfaceScope: null,
  });
  const after = latestRuntimeEventSeq();
  runtimeBus().broadcastMessage(legacy.id, {
    id: randomUUID(),
    topicId: legacy.id,
    authorId: "ai",
    text: "must not cross the strict workspace boundary",
    createdAt: new Date().toISOString(),
  });

  const response = await handler(
    runtimeRequest(`/events?after=${after}`, {
      headers: {
        [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws_alpha",
        [NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER]: "1",
      },
    }),
  );
  const reader = response?.body?.getReader();
  try {
    const ready = await reader?.read();
    expect(new TextDecoder().decode(ready?.value)).toContain("event: ready");
    const next = await reader?.read();
    const payload = new TextDecoder().decode(next?.value);
    expect(payload).toContain("event: cursor");
    expect(payload).not.toContain("must not cross the strict workspace boundary");
  } finally {
    await reader?.cancel();
  }
});

test("knowing a room id does not get a foreign workspace past the boundary", async () => {
  const user = `topic-scope-id-${randomUUID()}`;
  const room = registerTopic({
    title: `Foreign ${randomUUID()}`,
    userId: user,
    agent: "codex",
    surface: "otium",
    surfaceScope: "ws_alpha",
  });
  const asBeta = (path: string, init: RequestInit = {}) =>
    handler(
      runtimeRequest(path, {
        ...init,
        headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws_beta", ...(init.headers ?? {}) },
      }),
    );

  // Discovery already hides the room, so the only way in is a known id — which
  // is exactly what an ex-member or a mis-mapped hub has.
  expect((await asBeta(`/topics/${room.id}`))?.status).toBe(404);
  expect((await asBeta(`/topics/${room.id}/messages`))?.status).toBe(404);
  const ranTurn = await asBeta("/turns", {
    method: "POST",
    body: JSON.stringify({
      v: NODE_RUNTIME_CONTRACT_VERSION,
      topicId: room.id,
      userId: user,
      text: "should not run",
      clientMessageId: randomUUID(),
      requestId: randomUUID(),
    }),
  });
  expect(ranTurn?.status).toBe(404);

  // Its own workspace still reaches it.
  const asAlpha = await handler(
    runtimeRequest(`/topics/${room.id}`, {
      headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws_alpha" },
    }),
  );
  expect(asAlpha?.status).toBe(200);
});

test("a gateway-created room is born in the caller's workspace", async () => {
  const createUser = `topic-scope-create-${randomUUID()}`;
  const title = `Created ${randomUUID()}`;
  const response = await handler(
    runtimeRequest("/topics", {
      method: "POST",
      headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws_alpha" },
      body: JSON.stringify({ v: NODE_RUNTIME_CONTRACT_VERSION, userId: createUser, title }),
    }),
  );
  expect(response?.status).toBe(201);
  const body = (await response?.json()) as { topic?: { id: string; surfaceScope?: string | null } };
  expect(body.topic?.surfaceScope).toBe("ws_alpha");

  // The same title is free in another workspace.
  const second = await handler(
    runtimeRequest("/topics", {
      method: "POST",
      headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws_beta" },
      body: JSON.stringify({ v: NODE_RUNTIME_CONTRACT_VERSION, userId: createUser, title }),
    }),
  );
  expect(second?.status).toBe(201);
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

test("runtime gateway returns a canonical thread when addressed by its root or a reply", async () => {
  const owner = `runtime-thread-${randomUUID()}`;
  const topic = registerTopic({ title: `Gateway thread ${randomUUID()}`, userId: owner });
  const root = {
    id: randomUUID(),
    topicId: topic.id,
    authorId: owner,
    text: "root",
    createdAt: new Date().toISOString(),
  };
  const reply = {
    id: randomUUID(),
    topicId: topic.id,
    authorId: owner,
    text: "reply",
    threadRootId: root.id,
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(root);
  appendApiMessage(reply);

  for (const messageId of [root.id, reply.id]) {
    const response = await handler(
      runtimeRequest(
        `/topics/${encodeURIComponent(topic.id)}/messages/${encodeURIComponent(messageId)}/thread`,
      ),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ok: true,
      v: NODE_RUNTIME_CONTRACT_VERSION,
      root: { id: root.id },
      replies: [{ id: reply.id, threadRootId: root.id }],
    });
  }
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

test("topic decisions route returns the topic-scoped graph only to a participant", async () => {
  const topic = registerTopic({ title: `Decisions ${randomUUID()}`, userId, agent: "codex" });
  try {
    writeDecisions(userId, topic.id, [
      {
        id: "1",
        action: "Use Orchgraph",
        reasoning: "The decisions form a directed graph",
        agent: "codex",
        status: "accepted",
        timestamp: 1,
      },
    ]);

    const response = await handler(
      request(
        `/topics/${encodeURIComponent(topic.id)}/decisions?user=${encodeURIComponent(userId)}`,
      ),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ok: true,
      decisions: [{ id: "1", action: "Use Orchgraph" }],
    });

    const forbidden = await handler(
      request(`/topics/${encodeURIComponent(topic.id)}/decisions?user=not-a-participant`),
    );
    expect(forbidden?.status).toBe(404);
  } finally {
    try {
      unlinkSync(getDecisionFilePath(userId, topic.id));
    } catch {}
  }
});

test("topic decision graph route atomically stores the latest SVG for a participant", async () => {
  const topic = registerTopic({ title: `Decision SVG ${randomUUID()}`, userId, agent: "codex" });
  const path = getDecisionGraphSvgPath(userId, topic.id);
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Decision graph</title></svg>';
    const response = await handler(
      request(`/topics/${encodeURIComponent(topic.id)}/decision-graph`, {
        method: "POST",
        body: JSON.stringify({ userId, svg }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(readFileSync(path, "utf-8")).toBe(svg);

    const forbidden = await handler(
      request(`/topics/${encodeURIComponent(topic.id)}/decision-graph`, {
        method: "POST",
        body: JSON.stringify({ userId: "not-a-participant", svg }),
      }),
    );
    expect(forbidden?.status).toBe(404);
  } finally {
    try {
      unlinkSync(path);
    } catch {}
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

/**
 * The gap that made `show_html` useless in a mapped room even once the
 * capability reached the node: the visual was rendered and stored *here*, and
 * the gateway had no way to read it back, so the hub's panel asked its own
 * database for an id that only exists on this node.
 */
test("runtime gateway can read back a visual a node turn rendered", async () => {
  const visualUser = `node-visual-${randomUUID()}`;
  const topic = registerTopic({
    title: `Visual ${randomUUID()}`,
    userId: visualUser,
    agent: "codex",
    surface: "otium",
  });
  // Stands in for what `show_html` does on this node during a mapped-room
  // turn. Inserted directly rather than via the core write helper, which is
  // not on the node-host surface and should not be widened for a test.
  const vizId = Number(
    (
      db
        .query(
          `INSERT INTO api_topic_visuals (topic_id, html, title, created_at, kind, source)
           VALUES (?, ?, ?, ?, 'html', ?) RETURNING id`,
        )
        .get(topic.id, "<section>chart</section>", "Quarterly", Date.now(), "<p>chart</p>") as {
        id: number;
      }
    ).id,
  );

  const response = await handler(runtimeRequest(`/topics/${topic.id}/visuals/${vizId}`));
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as {
    ok: boolean;
    v: number;
    visual: Record<string, unknown>;
  };
  expect(body.ok).toBe(true);
  expect(body.v).toBe(NODE_RUNTIME_CONTRACT_VERSION);
  expect(body.visual).toMatchObject({
    id: vizId,
    kind: "html",
    title: "Quarterly",
    // `source` keeps the agent's own input; `html` is the rendered document,
    // so a copying hub reproduces the card rather than re-styling it.
    source: "<p>chart</p>",
  });
  expect(String(body.visual.html)).toContain("chart");

  // A visual id from another room must not be readable by naming this one.
  const otherTopic = registerTopic({
    title: `Other ${randomUUID()}`,
    userId: visualUser,
    agent: "codex",
    surface: "otium",
  });
  const crossRoom = await handler(runtimeRequest(`/topics/${otherTopic.id}/visuals/${vizId}`));
  expect(crossRoom?.status).toBe(404);

  const missing = await handler(runtimeRequest(`/topics/${topic.id}/visuals/999999`));
  expect(missing?.status).toBe(404);
});

/**
 * Every mapped room executes as the same `local` principal, so a file ACL
 * keyed on the caller's user id authorizes nothing between workspaces. The
 * read is therefore addressed through its room and scoped like any other
 * topic route (M-8) — otherwise a gateway scoped to one workspace could fetch
 * another's bytes just by learning a file UUID.
 */
test("runtime gateway file reads are scoped to the room that owns them", async () => {
  // Registered under the execution principal, which is what a mapped room
  // actually looks like: `POST /turns` refuses a topic that principal is not a
  // participant of, so every gateway room has it.
  const fileUser = NODE_EXECUTION_PRINCIPAL_FOR_TEST;
  const topic = registerTopic({
    title: `Files ${randomUUID()}`,
    userId: fileUser,
    agent: "codex",
    surface: "otium",
  });
  const otherTopic = registerTopic({
    title: `Other files ${randomUUID()}`,
    userId: fileUser,
    agent: "codex",
    surface: "otium",
  });

  const scratch = join(tmpdir(), `node-file-scope-${randomUUID()}.txt`);
  writeFileSync(scratch, "delivered bytes");
  const stored = nodeFileStore.store(scratch, {
    ownerUserId: NODE_EXECUTION_PRINCIPAL_FOR_TEST,
    topicId: topic.id,
  });
  if (!stored) throw new Error("could not stage a node file");

  // A media visual resolved from `file_path` is stored with a topic and *no
  // owner* (see `resolveVisualMediaInput`), unlike `send_file` which sets both.
  // Gating the read on ownership therefore 404'd every `show_image`/`show_video`
  // while file delivery worked — the read must key on room membership only.
  const ownerless = nodeFileStore.store(scratch, { topicId: topic.id });
  if (!ownerless) throw new Error("could not stage an ownerless node file");

  const ok = await handler(
    runtimeRequest(
      `/topics/${topic.id}/files/${stored.id}?user=${NODE_EXECUTION_PRINCIPAL_FOR_TEST}`,
    ),
  );
  expect(ok?.status).toBe(200);
  expect(await ok?.text()).toBe("delivered bytes");

  // The same UUID, named through a room that does not own it, must not resolve
  // — this is the cross-workspace read the bare `/files/<id>` route allowed.
  const ownerlessRead = await handler(
    runtimeRequest(
      `/topics/${topic.id}/files/${ownerless.id}?user=${NODE_EXECUTION_PRINCIPAL_FOR_TEST}`,
    ),
  );
  expect(ownerlessRead?.status).toBe(200);
  expect(await ownerlessRead?.text()).toBe("delivered bytes");

  const wrongRoom = await handler(
    runtimeRequest(
      `/topics/${otherTopic.id}/files/${stored.id}?user=${NODE_EXECUTION_PRINCIPAL_FOR_TEST}`,
    ),
  );
  expect(wrongRoom?.status).toBe(404);

  // Room membership still confines the read: an ownerless file is not a public
  // file, it is just one whose owner was never recorded.
  const ownerlessWrongRoom = await handler(
    runtimeRequest(
      `/topics/${otherTopic.id}/files/${ownerless.id}?user=${NODE_EXECUTION_PRINCIPAL_FOR_TEST}`,
    ),
  );
  expect(ownerlessWrongRoom?.status).toBe(404);

  unlinkSync(scratch);
});
