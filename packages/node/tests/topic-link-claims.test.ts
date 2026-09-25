import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  appendApiMessage,
  asMessageId,
  asTopicId,
  asUserId,
  db,
  deleteTopicCascade,
  getTopic,
  getTopicCreateClaim,
  listTopics,
  NODE_CONTROL_TOKEN,
  registerTopic,
  runtimeBus,
  setDefaultSurfaceScope,
  setMountedSurfaceScopeCount,
  setSurfaceScopeRequired,
} from "@negotium/core";
import { NODE_ID } from "@negotium/core/node-host";
import {
  createNodeControlHandler,
  NODE_CONTROL_BASE_PATH,
  NODE_RUNTIME_SURFACE_SCOPE_HEADER,
  NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER,
} from "../src/control";
import {
  NODE_EXPECTED_NODE_ID_HEADER,
  OTIUM_LINK_EXPECTED_SCOPE_HEADER,
  OTIUM_LINK_GUARD_ENV,
  OTIUM_LINK_PROTOCOL_HEADER,
} from "../src/topic-link";

const userId = `topic-link-${randomUUID()}`;
const handler = createNodeControlHandler({
  port: () => 43218,
  startedAt: "2026-09-25T00:00:00.000Z",
  requestShutdown() {},
});

afterEach(() => {
  delete process.env[OTIUM_LINK_GUARD_ENV];
  setSurfaceScopeRequired(false);
  setDefaultSurfaceScope(null);
  setMountedSurfaceScopeCount(null);
});

afterAll(async () => {
  for (const topic of listTopics()) {
    if (!topic.participants.some((participant) => participant.userId === userId)) continue;
    await deleteTopicCascade(topic, userId).catch(() => {});
  }
});

function runtime(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:43218${NODE_CONTROL_BASE_PATH}/runtime/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${NODE_CONTROL_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function call(path: string, init: RequestInit = {}) {
  const response = await handler(runtime(path, init));
  if (!response) throw new Error(`no route for ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** The hub's `linkPayloadHash` (otium PR6), verbatim, to prove both sides agree. */
function hubHash(body: Record<string, unknown>): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  };
  const { requestId: _r, payloadHash: _p, ...payload } = body;
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

/** Exactly the body the hub's `createTopic` sends (topicCreateRequestBody + saga fields). */
function createBody(title: string, requestId?: string) {
  const body: Record<string, unknown> = { v: 1, userId, title, kind: "agent", agent: "codex" };
  if (requestId) {
    body.requestId = requestId;
    body.payloadHash = hubHash(body);
  }
  return body;
}

const PROTOCOL_2 = { [OTIUM_LINK_PROTOCOL_HEADER]: "2" };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path, { method: "POST", body: JSON.stringify(body), headers });
}

function roomsTitled(title: string) {
  return listTopics().filter((topic) => topic.title === title);
}

describe("create claims — POST /topics", () => {
  test("an old hub (no requestId, no header) gets the exact old response", async () => {
    const title = `Legacy create ${randomUUID()}`;
    const { status, body } = await post("/topics", createBody(title));
    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(["ok", "topic", "v"]);
    expect(body.topic.hostCreate).toBeUndefined();
    expect(roomsTitled(title)).toHaveLength(1);
  });

  test("records the claim with the topic and replays the original result", async () => {
    const title = `Claimed ${randomUUID()}`;
    const requestId = randomUUID();
    const sent = createBody(title, requestId);
    const first = await post("/topics", sent, PROTOCOL_2);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      ok: true,
      v: 1,
      requestId,
      replayed: false,
      payloadHash: sent.payloadHash,
    });
    expect(first.body.topic.hostCreate).toMatchObject({ requestId, op: "create" });

    const replay = await post("/topics", sent, PROTOCOL_2);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ requestId, replayed: true });
    expect(replay.body.topic.id).toBe(first.body.topic.id);
    expect(roomsTitled(title)).toHaveLength(1);
  });

  test("the same requestId with a different payload is a 409 and creates nothing", async () => {
    const title = `Conflict ${randomUUID()}`;
    const requestId = randomUUID();
    await post("/topics", createBody(title, requestId), PROTOCOL_2);
    const other = `${title} (other)`;
    const conflict = await post("/topics", createBody(other, requestId), PROTOCOL_2);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ ok: false, v: 1, code: "request_id_conflict" });
    expect(roomsTitled(other)).toHaveLength(0);
  });

  test("a response lost after commit is recoverable: the claim is durable before the reply", async () => {
    const title = `Lost reply ${randomUUID()}`;
    const requestId = randomUUID();
    const sent = createBody(title, requestId);
    // The node committed; the hub never reads the reply.
    const lost = await handler(runtime("/topics", { method: "POST", body: JSON.stringify(sent) }));
    expect(lost?.status).toBe(201);
    const [created] = roomsTitled(title);
    expect(getTopicCreateClaim("loopback", requestId)).toMatchObject({
      state: "committed",
      topicId: created?.id,
    });
    // Recovery by id, then the retry.
    const lookup = await call(`/topic-claims/${requestId}`);
    expect(lookup.body).toMatchObject({
      state: "committed",
      topicId: created?.id,
      topicPresent: true,
    });
    const retry = await post("/topics", sent);
    expect(retry.body).toMatchObject({ replayed: true, topic: { id: created?.id } });
  });

  test("claim and topic commit together: a failing claim write leaves no topic", async () => {
    const title = `Atomic ${randomUUID()}`;
    db.exec(`CREATE TRIGGER test_fail_claim BEFORE INSERT ON api_topic_create_claims
             BEGIN SELECT RAISE(ABORT, 'claim write failed'); END`);
    try {
      const response = await handler(
        runtime("/topics", {
          method: "POST",
          body: JSON.stringify(createBody(title, randomUUID())),
        }),
      );
      expect(response?.status).toBe(500);
    } finally {
      db.exec("DROP TRIGGER test_fail_claim");
    }
    expect(roomsTitled(title)).toHaveLength(0);
  });

  test("claims are per principal: another workspace reusing an id gets its own room", async () => {
    const requestId = randomUUID();
    const a = await post("/topics", createBody(`Principal A ${randomUUID()}`, requestId));
    const b = await post("/topics", createBody(`Principal B ${randomUUID()}`, requestId), {
      [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws-principal",
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.topic.id).not.toBe(a.body.topic.id);
  });

  test("hostCreate is only shown to the principal that created the room", async () => {
    const requestId = randomUUID();
    const created = await post("/topics", createBody(`Host create ${randomUUID()}`, requestId));
    const id = created.body.topic.id as string;

    const single = await call(`/topics/${id}`);
    expect(single.body.topic.hostCreate).toMatchObject({ requestId });
    const list = await call("/topics");
    expect(
      list.body.topics.find((topic: { id: string }) => topic.id === id)?.hostCreate,
    ).toMatchObject({ requestId });

    const scoped = await call(`/topics/${id}`, {
      headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "" },
    });
    // Unscoped room is legacy-reachable, but it was not this caller's create.
    expect(scoped.status).toBe(200);
    expect(scoped.body.topic.hostCreate).toBeUndefined();
  });

  test("a malformed requestId is a 400, never an unclaimed create", async () => {
    const title = `Bad id ${randomUUID()}`;
    const { status, body } = await post("/topics", { ...createBody(title), requestId: 42 });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_request_id");
    expect(roomsTitled(title)).toHaveLength(0);
  });
});

describe("create claims — POST /topics/:id/derive", () => {
  function deriveBody(sourceTopicId: string, name: string, requestId: string) {
    // The hub's derive intent payload: { v, sourceTopicId, ...topicDeriveRequestBody }.
    const hashed = { v: 1, sourceTopicId, userId, copyHistory: false, name };
    return { v: 1, userId, copyHistory: false, name, requestId, payloadHash: hubHash(hashed) };
  }

  test("claims, replays and refuses a reused id, hashing the path source id like the hub", async () => {
    const source = registerTopic({
      title: `Derive source ${randomUUID()}`,
      userId,
      surface: "otium",
    });
    const requestId = randomUUID();
    const name = `Derived ${randomUUID()}`;
    const sent = deriveBody(source.id, name, requestId);

    const first = await post(`/topics/${source.id}/derive`, sent, PROTOCOL_2);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ requestId, replayed: false, payloadHash: sent.payloadHash });
    expect(first.body.topic.hostCreate).toMatchObject({ requestId, op: "derive" });

    const replay = await post(`/topics/${source.id}/derive`, sent, PROTOCOL_2);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true, topic: { id: first.body.topic.id } });
    expect(roomsTitled(name)).toHaveLength(1);

    const reused = await post(
      `/topics/${source.id}/derive`,
      { ...sent, name: `${name} 2` },
      PROTOCOL_2,
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("request_id_conflict");

    // The same body under another parent is a different request.
    const other = registerTopic({
      title: `Other source ${randomUUID()}`,
      userId,
      surface: "otium",
    });
    const crossed = await post(`/topics/${other.id}/derive`, sent, PROTOCOL_2);
    expect(crossed.status).toBe(409);
  });
});

describe("claim abort and lookup", () => {
  test("an abort before the create fences a late create", async () => {
    const requestId = randomUUID();
    const aborted = await post(`/topic-claims/${requestId}/abort`, {});
    expect(aborted.body).toMatchObject({ aborted: true, existed: false, nodeId: NODE_ID });
    const title = `Late ${randomUUID()}`;
    const late = await post("/topics", createBody(title, requestId), PROTOCOL_2);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("request_aborted");
    expect(roomsTitled(title)).toHaveLength(0);
    expect((await call(`/topic-claims/${requestId}`)).body.state).toBe("aborted");
  });

  test("aborting an untouched room deletes it and tombstones it; replay then says aborted", async () => {
    const requestId = randomUUID();
    const sent = createBody(`Abort me ${randomUUID()}`, requestId);
    const created = await post("/topics", sent);
    const id = created.body.topic.id as string;
    const aborted = await post(`/topic-claims/${requestId}/abort`, {});
    expect(aborted.body).toMatchObject({
      aborted: true,
      existed: true,
      topicDeleted: true,
      topicId: id,
    });
    expect(getTopic(id)).toBeNull();
    expect((await call(`/topics/${id}/existence`)).body.state).toBe("gone");
    expect((await post("/topics", sent)).body.code).toBe("request_aborted");
    // Idempotent.
    expect((await post(`/topic-claims/${requestId}/abort`, {})).body.aborted).toBe(true);
  });

  test("a room that already holds new messages is never deleted by an abort", async () => {
    const requestId = randomUUID();
    const created = await post("/topics", createBody(`Busy ${randomUUID()}`, requestId));
    const id = created.body.topic.id as string;
    appendApiMessage({
      id: asMessageId(randomUUID()),
      topicId: asTopicId(id),
      authorId: asUserId(userId),
      text: "hello",
      createdAt: new Date().toISOString(),
    } as Parameters<typeof appendApiMessage>[0]);
    const refused = await post(`/topic-claims/${requestId}/abort`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("claim_topic_has_messages");
    expect(getTopic(id)).not.toBeNull();
    expect((await call(`/topic-claims/${requestId}`)).body.state).toBe("committed");
  });

  test("a replay of a claim whose room was deleted is a 410, not a new room", async () => {
    const requestId = randomUUID();
    const sent = createBody(`Deleted later ${randomUUID()}`, requestId);
    const created = await post("/topics", sent);
    const id = created.body.topic.id as string;
    const deleted = await handler(runtime(`/topics/${id}?user=${userId}`, { method: "DELETE" }));
    expect(deleted?.status).toBe(200);
    const replay = await post("/topics", sent);
    expect(replay.status).toBe(410);
    expect(replay.body).toMatchObject({ code: "claim_topic_gone", topicId: id });
  });

  test("an unknown claim reads as state none", async () => {
    expect((await call(`/topic-claims/${randomUUID()}`)).body.state).toBe("none");
  });
});

describe("existence and tombstones", () => {
  test("present / gone / unknown, and never gone from a mere 404", async () => {
    const created = await post("/topics", createBody(`Exists ${randomUUID()}`));
    const id = created.body.topic.id as string;
    expect((await call(`/topics/${id}/existence`)).body).toEqual({
      ok: true,
      v: 1,
      nodeId: NODE_ID,
      dbEpoch: expect.stringMatching(/^[0-9a-f]{32}$/),
      topicId: id,
      state: "present",
      shared: true,
    });

    const stranger = randomUUID();
    expect((await call(`/topics/${stranger}`)).status).toBe(404);
    expect((await call(`/topics/${stranger}/existence`)).body.state).toBe("unknown");

    await handler(runtime(`/topics/${id}?user=${userId}`, { method: "DELETE" }));
    const gone = (await call(`/topics/${id}/existence`)).body;
    expect(gone).toMatchObject({ state: "gone", nodeId: NODE_ID });
    expect(typeof gone.deletedAt).toBe("string");
  });

  test("a tombstone written under another identity is unknown, not gone", async () => {
    const created = await post("/topics", createBody(`Copied store ${randomUUID()}`));
    const id = created.body.topic.id as string;
    await handler(runtime(`/topics/${id}?user=${userId}`, { method: "DELETE" }));
    db.query("UPDATE api_topic_tombstones SET node_id = 'another-node' WHERE topic_id = ?").run(id);
    expect((await call(`/topics/${id}/existence`)).body.state).toBe("unknown");
  });

  test("a workspace-scoped caller only learns about its own workspace", async () => {
    const mine = { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws-mine" };
    const foreign = {
      [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws-foreign",
      [NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER]: "1",
    };
    const created = await post("/topics", createBody(`Scoped ${randomUUID()}`), mine);
    const id = created.body.topic.id as string;
    expect((await call(`/topics/${id}/existence`, { headers: mine })).body.state).toBe("present");
    expect((await call(`/topics/${id}/existence`, { headers: foreign })).body.state).toBe(
      "unknown",
    );

    await handler(runtime(`/topics/${id}?user=${userId}`, { method: "DELETE", headers: mine }));
    expect((await call(`/topics/${id}/existence`, { headers: mine })).body.state).toBe("gone");
    expect((await call(`/topics/${id}/existence`, { headers: foreign })).body.state).toBe(
      "unknown",
    );

    const page = (await call("/topic-tombstones?after=0&limit=500", { headers: foreign })).body;
    expect(page.tombstones.some((row: { topicId: string }) => row.topicId === id)).toBe(false);
  });

  test("the tombstone log is identity-stamped and pages by cursor", async () => {
    const created = await post("/topics", createBody(`Logged ${randomUUID()}`));
    const id = created.body.topic.id as string;
    await handler(runtime(`/topics/${id}?user=${userId}`, { method: "DELETE" }));
    let after = 0;
    let found: Record<string, unknown> | undefined;
    for (let page = 0; page < 100 && !found; page += 1) {
      const body = (await call(`/topic-tombstones?after=${after}&limit=2`)).body;
      found = body.tombstones.find((row: { topicId: string }) => row.topicId === id);
      if (!body.hasMore) break;
      after = body.cursor;
    }
    expect(found).toMatchObject({
      topicId: id,
      reason: "deleted",
      nodeId: NODE_ID,
      boundToNode: true,
      surface: "otium",
    });
  });

  test("topic-deleted events and the stream's ready frame name the node", async () => {
    const created = await post("/topics", createBody(`Evented ${randomUUID()}`));
    const id = created.body.topic.id as string;
    const seen: unknown[] = [];
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type === "topic-deleted" && event.topicId === id) seen.push(event.payload);
    });
    try {
      await handler(runtime(`/topics/${id}?user=${userId}`, { method: "DELETE" }));
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual([expect.objectContaining({ nodeId: NODE_ID, surface: "otium" })]);

    const controller = new AbortController();
    const stream = await handler(runtime("/events?after=0", { signal: controller.signal }));
    const reader = stream?.body?.getReader();
    const first = new TextDecoder().decode((await reader?.read())?.value);
    controller.abort();
    await reader?.cancel().catch(() => {});
    expect(first).toContain("event: ready");
    const data = first.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data?.slice(6) ?? "{}")).toMatchObject({ v: 1, nodeId: NODE_ID });
  });
});

describe("surface-scope lookup", () => {
  test("loopback: resolved single workspace, unresolved join, several workspaces", async () => {
    setMountedSurfaceScopeCount(1);
    setDefaultSurfaceScope("ws-one");
    expect((await call("/surface-scope")).body).toMatchObject({
      nodeId: NODE_ID,
      principal: "loopback",
      surfaceScope: "ws-one",
      resolved: true,
      scopeRequired: false,
      joinsMounted: 1,
      linkGuard: "off",
    });
    setDefaultSurfaceScope(null);
    expect((await call("/surface-scope")).body).toMatchObject({
      surfaceScope: null,
      resolved: false,
    });
    setMountedSurfaceScopeCount(2);
    setSurfaceScopeRequired(true);
    expect((await call("/surface-scope")).body).toMatchObject({
      surfaceScope: null,
      resolved: false,
      scopeRequired: true,
    });
    setMountedSurfaceScopeCount(0);
    setSurfaceScopeRequired(false);
    expect((await call("/surface-scope")).body).toMatchObject({
      surfaceScope: null,
      resolved: true,
    });
  });

  test("reports rooms the M-9 stamp still has pending (revision 5, additive)", async () => {
    // Only the diagnostic table is touched: no room is stamped or created.
    const id = `pending-${randomUUID()}`;
    const before = (await call("/surface-scope")).body.unscopedPending as number;
    expect(typeof before).toBe("number");
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO api_surface_scope_stamp_pending
         (topic_id, scope, reason, detail, attempts, first_seen_at, last_attempt_at)
       VALUES (?, 'ws-one', 'title_conflict', NULL, 2, ?, ?)`,
    ).run(id, now, now);
    try {
      expect((await call("/surface-scope")).body.unscopedPending).toBe(before + 1);
    } finally {
      db.query("DELETE FROM api_surface_scope_stamp_pending WHERE topic_id = ?").run(id);
    }
    expect((await call("/surface-scope")).body.unscopedPending).toBe(before);
  });

  test("relayed: the scope the sidecar stamped", async () => {
    expect(
      (await call("/surface-scope", { headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws-r" } }))
        .body,
    ).toMatchObject({ principal: "scoped", surfaceScope: "ws-r", resolved: true });
    expect(
      (await call("/surface-scope", { headers: { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "" } })).body,
    ).toMatchObject({ principal: "scoped", surfaceScope: null, resolved: false });
  });
});

describe(`${OTIUM_LINK_GUARD_ENV} create guard`, () => {
  function severalWorkspaces() {
    setMountedSurfaceScopeCount(2);
    setSurfaceScopeRequired(true);
  }

  test("off (default): unchanged behaviour even for a protocol-2 caller", async () => {
    const title = `Guard off ${randomUUID()}`;
    const response = await post("/topics", createBody(title), PROTOCOL_2);
    expect(response.status).toBe(201);
  });

  test("on: an unresolved scope refuses a protocol-2 caller with scope_unresolved", async () => {
    process.env[OTIUM_LINK_GUARD_ENV] = "1";
    severalWorkspaces();
    const title = `Guard unresolved ${randomUUID()}`;
    const refused = await post("/topics", createBody(title), PROTOCOL_2);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, v: 1, code: "scope_unresolved" });
    const manager = await post("/manager-topic", { v: 1, userId }, PROTOCOL_2);
    expect(manager.status).toBe(409);
    expect(manager.body.code).toBe("scope_unresolved");
    expect(roomsTitled(title)).toHaveLength(0);
  });

  test("on: an old hub without the protocol header keeps the old behaviour", async () => {
    process.env[OTIUM_LINK_GUARD_ENV] = "on";
    setMountedSurfaceScopeCount(1);
    setDefaultSurfaceScope("ws-g");
    const response = await post("/topics", createBody(`Guard old hub ${randomUUID()}`));
    expect(response.status).toBe(201);
  });

  test("on: an expected scope that differs is scope_mismatch; a matching one passes", async () => {
    process.env[OTIUM_LINK_GUARD_ENV] = "1";
    setMountedSurfaceScopeCount(1);
    setDefaultSurfaceScope("ws-actual");
    const mismatch = await post("/topics", createBody(`Guard mismatch ${randomUUID()}`), {
      ...PROTOCOL_2,
      [OTIUM_LINK_EXPECTED_SCOPE_HEADER]: "ws-cached",
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({
      code: "scope_mismatch",
      surfaceScope: "ws-actual",
      expectedSurfaceScope: "ws-cached",
    });
    const ok = await post("/topics", createBody(`Guard match ${randomUUID()}`), {
      ...PROTOCOL_2,
      [OTIUM_LINK_EXPECTED_SCOPE_HEADER]: "ws-actual",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.topic.surfaceScope).toBe("ws-actual");
  });

  test("on: a relayed caller whose workspace is not resolved yet is refused", async () => {
    process.env[OTIUM_LINK_GUARD_ENV] = "1";
    const refused = await post("/topics", createBody(`Guard relay ${randomUUID()}`), {
      ...PROTOCOL_2,
      [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "",
    });
    expect(refused.body.code).toBe("scope_unresolved");
  });

  test("strict: a caller without protocol 2 is refused; a protocol-2 caller is not", async () => {
    process.env[OTIUM_LINK_GUARD_ENV] = "strict";
    const title = `Guard strict ${randomUUID()}`;
    const refused = await post("/topics", createBody(title));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("link_protocol_required");
    expect(roomsTitled(title)).toHaveLength(0);
    const accepted = await post("/topics", createBody(title), PROTOCOL_2);
    expect(accepted.status).toBe(201);
  });

  test("a replay is answered before the guard: nothing new is created either way", async () => {
    const requestId = randomUUID();
    const sent = createBody(`Guard replay ${randomUUID()}`, requestId);
    await post("/topics", sent, PROTOCOL_2);
    process.env[OTIUM_LINK_GUARD_ENV] = "strict";
    const replay = await post("/topics", sent);
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);
  });
});

test("health advertises the topic-link capabilities", async () => {
  const { body } = await call("/health");
  expect(body.capabilities).toEqual(
    expect.arrayContaining([
      "canonical-topic-create-claims",
      "canonical-topic-existence",
      "canonical-topic-tombstones",
      "canonical-surface-scope",
    ]),
  );
  // The store epoch is the same on every identity-bearing surface.
  expect(body.dbEpoch).toMatch(/^[0-9a-f]{32}$/);
  expect((await call("/surface-scope")).body.dbEpoch).toBe(body.dbEpoch);
  const page = (await call("/topic-tombstones?after=0&limit=1")).body;
  expect(page.dbEpoch).toBe(body.dbEpoch);
  expect(typeof page.highWater).toBe("number");
  expect(page.highWater).toBeGreaterThanOrEqual(page.cursor);
});

describe("conditional delete — DELETE /topics/:id (revision 7)", () => {
  async function room(label: string): Promise<string> {
    const created = await post("/topics", createBody(`${label} ${randomUUID()}`));
    expect(created.status).toBe(201);
    return created.body.topic.id as string;
  }
  function del(id: string, headers: Record<string, string> = {}) {
    return call(`/topics/${id}?user=${userId}`, { method: "DELETE", headers });
  }

  test("an expected identity of another node is 409 and deletes nothing", async () => {
    const id = await room("Other node");
    const { status, body } = await del(id, { [NODE_EXPECTED_NODE_ID_HEADER]: "node-b" });
    expect(status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      code: "node_identity_mismatch",
      nodeId: NODE_ID,
      expectedNodeId: "node-b",
    });
    expect(typeof body.error).toBe("string");
    expect(getTopic(id)).toBeTruthy();
    expect((await call(`/topics/${id}/existence`)).body.state).toBe("present");
  });

  test("a mismatch is answered before the topic lookup (an unknown id is 409, not 404)", async () => {
    const { status, body } = await del(randomUUID(), { [NODE_EXPECTED_NODE_ID_HEADER]: "node-b" });
    expect(status).toBe(409);
    expect(body.code).toBe("node_identity_mismatch");
  });

  test("a blank expected identity is 400 and deletes nothing", async () => {
    const id = await room("Blank identity");
    const { status, body } = await del(id, { [NODE_EXPECTED_NODE_ID_HEADER]: "  " });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_expected_node_id");
    expect(getTopic(id)).toBeTruthy();
  });

  test("the matching identity deletes and the 2xx carries nodeId and dbEpoch", async () => {
    const id = await room("Matching identity");
    const { status, body } = await del(id, { [NODE_EXPECTED_NODE_ID_HEADER]: ` ${NODE_ID} ` });
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      v: 1,
      topicId: id,
      nodeId: NODE_ID,
      dbEpoch: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(body.dbEpoch).toBe((await call("/health")).body.dbEpoch);
    expect(getTopic(id)).toBeFalsy();
    expect((await call(`/topics/${id}/existence`)).body.state).toBe("gone");
  });

  test("a store stamped with another identity refuses even a matching header", async () => {
    const id = await room("Copied store");
    const guard = await import("../src/topic-link");
    db.query("UPDATE api_node_identity SET node_id = 'node-a' WHERE singleton = 1").run();
    try {
      // Direct guard call: an authenticated request would re-stamp the store first.
      const refusal = guard.topicDeleteIdentityGuard(
        runtime(`/topics/${id}`, {
          method: "DELETE",
          headers: { [NODE_EXPECTED_NODE_ID_HEADER]: NODE_ID },
        }),
        id,
      );
      expect(refusal?.status).toBe(409);
      expect(((await refusal?.json()) as { code: string }).code).toBe("node_identity_mismatch");
    } finally {
      db.query("UPDATE api_node_identity SET node_id = ? WHERE singleton = 1").run(NODE_ID);
    }
    expect(getTopic(id)).toBeTruthy();
  });

  test("without the header an old hub's delete still works (compat), now with nodeId", async () => {
    const id = await room("Old hub delete");
    const { status, body } = await del(id);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, v: 1, nodeId: NODE_ID });
    expect(getTopic(id)).toBeFalsy();
  });

  test("health advertises canonical-topic-delete-conditional exactly once", async () => {
    const { body } = await call("/health");
    const capabilities = body.capabilities as string[];
    expect(capabilities.filter((c) => c === "canonical-topic-delete-conditional")).toEqual([
      "canonical-topic-delete-conditional",
    ]);
  });
});
