import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  deleteTopicCascade,
  getTopic,
  NODE_CONTROL_TOKEN,
  registerTopic,
  upsertTopic,
} from "@negotium/core";
import {
  createNodeControlHandler,
  NODE_CONTROL_BASE_PATH,
  NODE_RUNTIME_SURFACE_SCOPE_HEADER,
  NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER,
} from "../src/control";

const userId = `runtime-mutations-${randomUUID()}`;

// The SQLite fixture is shared across the whole run, so every topic this file
// creates is tracked and removed — see control-error-typing.test.ts.
const createdTopics: ReturnType<typeof registerTopic>[] = [];
function topic(title: string, agent: "claude" | "codex" = "codex") {
  const created = registerTopic({ title, userId, agent });
  createdTopics.push(created);
  return created;
}

afterAll(async () => {
  for (const created of createdTopics) {
    await deleteTopicCascade(created, userId).catch(() => {
      // Best-effort teardown; a failure here must not fail the suite.
    });
  }
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:43217${NODE_CONTROL_BASE_PATH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${NODE_CONTROL_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** A caller that speaks for another workspace, on a node serving several. */
const foreignScope = {
  [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "some-other-workspace",
  [NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER]: "1",
};

const handler = createNodeControlHandler({
  port: () => 43217,
  startedAt: "2026-08-11T00:00:00.000Z",
  requestShutdown() {},
});

test("health advertises the delete/update/silent capabilities hosts feature-detect on", async () => {
  const response = await handler(request("/runtime/v1/health"));
  const body = (await response?.json()) as { capabilities: string[] };
  expect(body.capabilities).toContain("canonical-topic-delete");
  expect(body.capabilities).toContain("canonical-topic-update");
  expect(body.capabilities).toContain("turn-submit-silent");
});

test("DELETE removes the canonical topic so a deleted mirror stays deleted", async () => {
  const created = topic(`Runtime delete ${randomUUID()}`);
  const response = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}?user=${userId}`, {
      method: "DELETE",
    }),
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ ok: true, v: 1 });
  expect(getTopic(created.id)).toBeNull();
  createdTopics.splice(createdTopics.indexOf(created), 1);
});

test("DELETE is a 404 for a missing room and for one in another workspace", async () => {
  const created = topic(`Runtime delete scope ${randomUUID()}`);

  const missing = await handler(
    request(`/runtime/v1/topics/${randomUUID()}?user=${userId}`, { method: "DELETE" }),
  );
  expect(missing?.status).toBe(404);

  // Never "403 forbidden": that would confirm the room exists to a workspace
  // that must not be able to tell.
  const foreign = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}?user=${userId}`, {
      method: "DELETE",
      headers: foreignScope,
    }),
  );
  expect(foreign?.status).toBe(404);
  expect(getTopic(created.id)).not.toBeNull();

  // A stranger gets the same 404, not a 403 — a room they cannot see must not
  // be distinguishable from one that does not exist.
  const stranger = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}?user=someone-else`, {
      method: "DELETE",
    }),
  );
  expect(stranger?.status).toBe(404);

  // A member who is not the owner is a genuine 403: they can see the room, so
  // there is nothing to hide, and the refusal should say why.
  const stored = getTopic(created.id);
  if (!stored) throw new Error("topic vanished");
  upsertTopic({
    ...stored,
    participants: [...stored.participants, { userId: "member-not-owner", role: "member" }],
  });
  const forbidden = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}?user=member-not-owner`, {
      method: "DELETE",
    }),
  );
  expect(forbidden?.status).toBe(403);
  expect(getTopic(created.id)).not.toBeNull();
});

test("PATCH writes the agent/model/effort the turn runner actually reads", async () => {
  const created = topic(`Runtime patch ${randomUUID()}`);
  const response = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        v: 1,
        userId,
        title: "Renamed by the host",
        agent: "claude",
        defaultModel: "sonnet",
        defaultEffort: "high",
      }),
    }),
  );
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as {
    ok: boolean;
    v: number;
    topic: { title: string; agent: string; defaultModel: string; defaultEffort: string };
  };
  expect(body.ok).toBeTrue();
  expect(body.v).toBe(1);
  expect(body.topic).toMatchObject({
    title: "Renamed by the host",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "high",
  });
  expect(getTopic(created.id)).toMatchObject({ agent: "claude", defaultModel: "sonnet" });
});

test("PATCH leaves absent fields alone and treats agent:null as removal", async () => {
  const created = topic(`Runtime patch partial ${randomUUID()}`);

  const renamed = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ v: 1, userId, title: `Only renamed ${randomUUID()}` }),
    }),
  );
  expect(renamed?.status).toBe(200);
  // Absent is not null: a rename must not reset the backend as a side effect.
  expect(getTopic(created.id)?.agent).toBe("codex");

  const cleared = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ v: 1, userId, agent: null }),
    }),
  );
  expect(cleared?.status).toBe(200);
  expect(getTopic(created.id)?.agent).toBeUndefined();
  expect(getTopic(created.id)?.aiMode).toBe("off");
});

test("PATCH sets mention-only mode without dropping the backend", async () => {
  const created = topic(`Runtime patch mention ${randomUUID()}`);
  const response = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ v: 1, userId, aiMode: "mention" }),
    }),
  );
  expect(response?.status).toBe(200);
  expect(getTopic(created.id)).toMatchObject({
    kind: "channel",
    aiMode: "mention",
    agent: "codex",
  });
});

test("PATCH rejects a bad envelope, a bad field and a taken title", async () => {
  const created = topic(`Runtime patch invalid ${randomUUID()}`);
  const other = topic(`Runtime patch other ${randomUUID()}`);

  const badVersion = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ v: 2, userId }),
    }),
  );
  expect(badVersion?.status).toBe(400);
  expect(((await badVersion?.json()) as { error: string }).error).toBe("Unsupported v");

  const noUser = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ v: 1, title: "x" }),
    }),
  );
  expect(noUser?.status).toBe(400);
  expect(((await noUser?.json()) as { error: string }).error).toBe("userId is required");

  for (const patch of [
    { agent: "gemini" },
    { aiMode: "sometimes" },
    { defaultModel: 42 },
    { agent: "claude", defaultModel: "gpt-5.6-terra" },
    { title: "   " },
  ]) {
    const response = await handler(
      request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ v: 1, userId, ...patch }),
      }),
    );
    expect(response?.status, JSON.stringify(patch)).toBe(400);
  }

  const conflict = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ v: 1, userId, title: other.title }),
    }),
  );
  expect(conflict?.status).toBe(409);
});

test("PATCH is a 404 for another workspace's room and for a non-participant", async () => {
  const created = topic(`Runtime patch scope ${randomUUID()}`);

  const foreign = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      headers: foreignScope,
      body: JSON.stringify({ v: 1, userId, title: "stolen" }),
    }),
  );
  expect(foreign?.status).toBe(404);

  const stranger = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ v: 1, userId: "not-a-member", title: "stolen" }),
    }),
  );
  expect(stranger?.status).toBe(404);
  expect(getTopic(created.id)?.title).toBe(created.title);
});

test("POST /turns with respond:false acknowledges the message without queueing a turn", async () => {
  const created = topic(`Runtime silent turn ${randomUUID()}`);
  const response = await handler(
    request("/runtime/v1/turns", {
      method: "POST",
      body: JSON.stringify({
        v: 1,
        topicId: created.id,
        userId,
        text: "humans only",
        clientMessageId: randomUUID(),
        respond: false,
      }),
    }),
  );
  // The 202 shape is unchanged; only the queued turn is absent, which the
  // messages route can confirm without reaching into storage.
  expect(response?.status).toBe(202);
  const body = (await response?.json()) as { accepted: boolean; messageId: string };
  expect(body.accepted).toBeTrue();

  const messages = await handler(
    request(`/runtime/v1/topics/${encodeURIComponent(created.id)}/messages`),
  );
  const page = (await messages?.json()) as { page: Array<{ id: string; text: string }> };
  expect(page.page.map((message) => message.id)).toContain(body.messageId);
});
