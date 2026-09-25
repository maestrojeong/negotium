/**
 * PR7 review round 2 — regressions for blockers 5-7 and follow-ups B/C/D plus
 * the audited otium scope repair (PR12 requirement).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  topicLinkNodeIdentity,
} from "@negotium/core";
import * as nodeHost from "@negotium/core/node-host";
import { NODE_ID } from "@negotium/core/node-host";
import {
  createNodeControlHandler,
  NODE_CONTROL_BASE_PATH,
  NODE_RUNTIME_SURFACE_SCOPE_HEADER,
} from "../src/control";

const userId = `topic-link-r2-${randomUUID()}`;
const handler = createNodeControlHandler({
  port: () => 43220,
  startedAt: "2026-09-25T00:00:00.000Z",
  requestShutdown() {},
});
const DAY = 24 * 60 * 60_000;

// Namespace access: these exports are new, and this file must still load
// against the pre-fix module to prove the regressions fail there.
const core = nodeHost as unknown as Record<string, any>;

afterAll(async () => {
  for (const topic of listTopics()) {
    if (!topic.participants.some((participant) => participant.userId === userId)) continue;
    await deleteTopicCascade(topic, userId).catch(() => {});
  }
});

function runtime(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:43220${NODE_CONTROL_BASE_PATH}/runtime/v1${path}`, {
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

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(path, { method: "POST", body: JSON.stringify(body), headers });
}

function createBody(title: string, requestId?: string) {
  const body: Record<string, unknown> = { v: 1, userId, title, kind: "agent", agent: "codex" };
  if (requestId) body.requestId = requestId;
  return body;
}

function source(title = `R2 source ${randomUUID()}`) {
  return registerTopic({ title, userId, surface: "otium" });
}

function message(topicId: string, text: string) {
  return {
    id: asMessageId(randomUUID()),
    topicId: asTopicId(topicId),
    authorId: asUserId(userId),
    text,
    createdAt: new Date().toISOString(),
  } as Parameters<typeof appendApiMessage>[0];
}

/** Move an otium room to another scope behind the trigger's back (legacy/forced state). */
function forceScope(topicId: string, scope: string | null) {
  db.transaction(() => {
    const hasGrants = db
      .query("SELECT 1 FROM sqlite_master WHERE name = 'api_topic_scope_repair_grants'")
      .get();
    if (hasGrants) {
      db.query("INSERT INTO api_topic_scope_repair_grants (topic_id) VALUES (?)").run(topicId);
    }
    db.query("UPDATE api_topics SET surface_scope = ? WHERE id = ?").run(scope, topicId);
    if (hasGrants) {
      db.query("DELETE FROM api_topic_scope_repair_grants WHERE topic_id = ?").run(topicId);
    }
  })();
}

describe("blocker 5 — a derive claim is bound to its path source", () => {
  test("a forged body.sourceTopicId cannot make two parents share a claim", async () => {
    const a = source();
    const b = source();
    const requestId = randomUUID();
    const forged = {
      v: 1,
      userId,
      copyHistory: false,
      name: `Forged ${randomUUID()}`,
      requestId,
      sourceTopicId: "fixed",
    };
    const onA = await post(`/topics/${a.id}/derive`, forged);
    const onB = await post(`/topics/${b.id}/derive`, forged);
    // Never: B answered with A's child as a replay.
    const leaked =
      onA.status === 201 && onB.status === 201 && onB.body.topic?.id === onA.body.topic?.id;
    expect(leaked).toBe(false);
    expect(onA.status).toBe(400);
    expect(onA.body.code).toBe("source_topic_mismatch");
    expect(onB.status).toBe(400);
  });

  test("a claim recorded for parent A never replays on parent B, even with a colliding hash", async () => {
    const a = source();
    const b = source();
    const requestId = randomUUID();
    const body = { v: 1, userId, copyHistory: false, name: `Bound ${randomUUID()}`, requestId };
    const first = await post(`/topics/${a.id}/derive`, body);
    expect(first.status).toBe(201);
    // Legacy/colliding hash: pretend the stored hash equals what B would hash to.
    const bHash = core.topicLinkPayloadHash({ ...body, sourceTopicId: b.id });
    db.query(
      "UPDATE api_topic_create_claims SET payload_hash = ? WHERE principal_key = 'loopback' AND request_id = ?",
    ).run(bHash, requestId);
    const onB = await post(`/topics/${b.id}/derive`, body);
    expect(onB.status).toBe(409);
    expect(onB.body.code).toBe("request_id_conflict");
    expect(getTopicCreateClaim("loopback", requestId)?.sourceTopicId).toBe(a.id);
  });

  test("the same parent still replays 201; a replay needs source access again", async () => {
    const a = source();
    const requestId = randomUUID();
    const body = { v: 1, userId, copyHistory: false, name: `Replay ${randomUUID()}`, requestId };
    const first = await post(`/topics/${a.id}/derive`, body);
    const again = await post(`/topics/${a.id}/derive`, body);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ replayed: true, topic: { id: first.body.topic.id } });
    // Same id in the body is accepted.
    const explicit = await post(`/topics/${a.id}/derive`, { ...body, sourceTopicId: a.id });
    expect(explicit.status).toBe(201);
    expect(explicit.body.topic.id).toBe(first.body.topic.id);

    await deleteTopicCascade(a, userId);
    const afterSourceGone = await post(`/topics/${a.id}/derive`, body);
    expect(afterSourceGone.status).toBe(404);
  });
});

describe("residual (ii) — requestId is exact, never trimmed", () => {
  test("leading/trailing whitespace is a 400 on create and on the claim routes", async () => {
    const padded = ` ${randomUUID()} `;
    const created = await post("/topics", createBody(`Padded ${randomUUID()}`, padded));
    expect(created.status).toBe(400);
    expect(created.body.code).toBe("invalid_request_id");
    const view = await call(`/topic-claims/${encodeURIComponent(padded)}`);
    expect(view.status).toBe(400);
    const abort = await post(`/topic-claims/${encodeURIComponent(padded)}/abort`, {});
    expect(abort.status).toBe(400);
  });
});

describe("blocker 6 — an otium room's scope is immutable; old claims lose authority", () => {
  test("A -> B (and NULL -> A) is refused for every writer but the audited repair", () => {
    const scoped = registerTopic({
      title: `Scoped ${randomUUID()}`,
      userId,
      surface: "otium",
      surfaceScope: "ws-a",
    });
    expect(() =>
      db.query("UPDATE api_topics SET surface_scope = 'ws-b' WHERE id = ?").run(scoped.id),
    ).toThrow("otium_topic_scope_immutable");
    const unscoped = registerTopic({
      title: `Unscoped ${randomUUID()}`,
      userId,
      surface: "otium",
      surfaceScope: null,
    });
    expect(() =>
      db.query("UPDATE api_topics SET surface_scope = 'ws-a' WHERE id = ?").run(unscoped.id),
    ).toThrow("otium_topic_scope_immutable");
    expect(getTopic(scoped.id)?.surfaceScope).toBe("ws-a");
    expect(getTopic(unscoped.id)?.surfaceScope).toBeNull();
  });

  test("a claim whose room was moved to another scope neither replays nor aborts", async () => {
    const wsA = { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws-a" };
    const requestId = randomUUID();
    const sent = createBody(`Moved ${randomUUID()}`, requestId);
    const created = await post("/topics", sent, wsA);
    expect(created.status).toBe(201);
    const id = created.body.topic.id as string;
    forceScope(id, "ws-b");

    const replay = await post("/topics", sent, wsA);
    expect(replay.status).not.toBe(201);
    expect(replay.body.topic).toBeUndefined();
    expect(replay.body.code).toBe("claim_topic_moved");

    const aborted = await post(`/topic-claims/${requestId}/abort`, {}, wsA);
    expect(getTopic(id)).not.toBeNull();
    expect(aborted.status).toBe(409);
    expect(aborted.body.code).toBe("claim_topic_moved");
    expect(getTopicCreateClaim("scope:ws-a", requestId)?.state).toBe("committed");

    const view = (await call(`/topic-claims/${requestId}`, { headers: wsA })).body;
    expect(view).toMatchObject({ state: "committed", topicPresent: false, topicMoved: true });
  });
});

describe("PR12 — adminRepairOtiumTopicScope", () => {
  const unresolved = { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "" };
  const wsR = { [NODE_RUNTIME_SURFACE_SCOPE_HEADER]: "ws-r" };

  async function unscopedClaimedRoom() {
    const requestId = randomUUID();
    const sent = createBody(`Repair ${randomUUID()}`, requestId);
    const created = await post("/topics", sent, unresolved);
    expect(created.status).toBe(201);
    const id = created.body.topic.id as string;
    return { requestId, sent, id, row: getTopic(id) };
  }

  test("NULL -> scope moves the room, leaves claims on their principal, and tells the old scope", async () => {
    const { requestId, sent, id, row } = await unscopedClaimedRoom();
    expect(row?.surfaceScope).toBeNull();
    const cursor = (await call("/topic-tombstones?after=0&limit=1", { headers: unresolved })).body
      .highWater as number;

    const result = core.adminRepairOtiumTopicScope({
      topicId: id,
      fromScope: null,
      toScope: "ws-r",
      expectedRow: { surface: "otium", surfaceScope: null, createdAt: row?.createdAt },
      actor: "test-admin",
      reason: "test",
    });
    expect(result).toMatchObject({ ok: true, fromScope: null, toScope: "ws-r", claimsLeft: 1 });
    expect(result.moveSeq).toBeGreaterThan(cursor);
    expect(getTopic(id)?.surfaceScope).toBe("ws-r");
    // Not re-bound: the new scope's principal gains no authority over the room.
    expect(getTopicCreateClaim("scope:", requestId)?.state).toBe("committed");
    expect(getTopicCreateClaim("scope:ws-r", requestId)).toBeNull();
    expect(
      db
        .query(
          "SELECT actor, from_scope, to_scope, claims_left FROM api_topic_scope_moves WHERE seq = ?",
        )
        .get(result.moveSeq),
    ).toEqual({ actor: "test-admin", from_scope: null, to_scope: "ws-r", claims_left: 1 });
    expect(db.query("SELECT * FROM api_topic_scope_repair_grants").all()).toEqual([]);

    // The old principal's claim no longer returns or deletes the room.
    const replay = await post("/topics", sent, unresolved);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("claim_topic_moved");
    const aborted = await post(`/topic-claims/${requestId}/abort`, {}, unresolved);
    expect(aborted.body.code).toBe("claim_topic_moved");
    expect(getTopic(id)).not.toBeNull();
    // The new scope's principal cannot abort it through that claim either.
    const foreign = await post(`/topic-claims/${requestId}/abort`, {}, wsR);
    expect(foreign.body).toMatchObject({ existed: false });
    expect(getTopic(id)).not.toBeNull();

    // Feed: the old scope sees an `unshared` scope move; the new scope does not.
    const oldFeed = (
      await call(`/topic-tombstones?after=${cursor}&limit=500`, { headers: unresolved })
    ).body;
    expect(oldFeed.tombstones).toContainEqual(
      expect.objectContaining({
        topicId: id,
        reason: "unshared",
        scopeMoved: true,
        seq: result.moveSeq,
      }),
    );
    const newFeed = (await call(`/topic-tombstones?after=${cursor}&limit=500`, { headers: wsR }))
      .body;
    expect(newFeed.tombstones.some((row: { topicId: string }) => row.topicId === id)).toBe(false);
    // Existence: the old scope learns "present, no longer shared with you".
    expect((await call(`/topics/${id}/existence`, { headers: unresolved })).body).toMatchObject({
      state: "present",
      shared: false,
    });
    expect((await call(`/topics/${id}/existence`, { headers: wsR })).body).toMatchObject({
      state: "present",
      shared: true,
    });
  });

  test("refuses: already scoped, row changed, bad scope — and changes nothing", async () => {
    const scoped = registerTopic({
      title: `Has scope ${randomUUID()}`,
      userId,
      surface: "otium",
      surfaceScope: "ws-x",
    });
    const base = { fromScope: null, toScope: "ws-r", actor: "test-admin", reason: "test" };
    expect(
      core.adminRepairOtiumTopicScope({
        ...base,
        topicId: scoped.id,
        expectedRow: { surface: "otium", surfaceScope: null },
      }).reason,
    ).toBe("scope_not_null");

    const { id } = await unscopedClaimedRoom();
    expect(
      core.adminRepairOtiumTopicScope({
        ...base,
        topicId: id,
        expectedRow: {
          surface: "otium",
          surfaceScope: null,
          createdAt: "1999-01-01T00:00:00.000Z",
        },
      }).reason,
    ).toBe("row_changed");
    expect(
      core.adminRepairOtiumTopicScope({
        ...base,
        toScope: " ws-r",
        topicId: id,
        expectedRow: { surface: "otium", surfaceScope: null },
      }).reason,
    ).toBe("invalid_scope");
    expect(getTopic(id)?.surfaceScope).toBeNull();
    expect(db.query("SELECT 1 FROM api_topic_scope_moves WHERE topic_id = ?").get(id)).toBeNull();
  });
});

describe("follow-up B — abort compares the exact seeded message set", () => {
  test("a post-create message renumbered below the seed rowid still blocks the abort", async () => {
    const requestId = randomUUID();
    const created = await post("/topics", createBody(`Renumbered ${randomUUID()}`, requestId));
    const id = created.body.topic.id as string;
    const late = message(id, "written after create");
    appendApiMessage(late, { notify: false });
    // A logical dump/import renumbered rowids: the late message now sits below
    // the recorded seed boundary.
    db.query(
      "UPDATE api_topic_create_claims SET seed_max_message_rowid = 1000000000 WHERE request_id = ?",
    ).run(requestId);
    const aborted = await post(`/topic-claims/${requestId}/abort`, {});
    expect(getTopic(id)).not.toBeNull();
    expect(db.query("SELECT id FROM api_messages WHERE id = ?").get(late.id)).toBeTruthy();
    expect(aborted.body.code).toBe("claim_topic_has_messages");
  });

  test("a fork holding exactly its seeded history is still aborted", async () => {
    const parent = source();
    appendApiMessage(message(parent.id, "history"), { notify: false });
    const requestId = randomUUID();
    const derived = await post(`/topics/${parent.id}/derive`, {
      v: 1,
      userId,
      copyHistory: true,
      name: `Fork ${randomUUID()}`,
      requestId,
    });
    expect(derived.status).toBe(201);
    const claim = getTopicCreateClaim("loopback", requestId);
    expect(claim?.seedMessageCount).toBeGreaterThan(0);
    const aborted = await post(`/topic-claims/${requestId}/abort`, {});
    expect(aborted.body).toMatchObject({ topicDeleted: true });
  });
});

describe("blocker 7 — an abort fence is retained from its settlement", () => {
  test("a day-31 abort of an old claim still refuses a late create after the prune", async () => {
    const requestId = randomUUID();
    const sent = createBody(`Old claim ${randomUUID()}`, requestId);
    const created = await post("/topics", sent);
    expect(created.status).toBe(201);
    const old = new Date(Date.now() - 31 * DAY).toISOString();
    db.query(
      "UPDATE api_topic_create_claims SET created_at = ?, updated_at = ? WHERE request_id = ?",
    ).run(old, old, requestId);
    const aborted = await post(`/topic-claims/${requestId}/abort`, {});
    expect(aborted.body.topicDeleted).toBe(true);
    const settled = db
      .query<{ settled_at: string | null }, [string]>(
        "SELECT settled_at FROM api_topic_create_claims WHERE request_id = ?",
      )
      .get(requestId)?.settled_at;
    expect(Date.parse(settled ?? "") > Date.now() - 60_000).toBe(true);

    core.pruneTopicCreateClaims(Date.now());
    const late = await post("/topics", sent);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("request_aborted");
  });

  test("a fence written on day 0 survives day 29 and is pruned after the full window", async () => {
    const requestId = randomUUID();
    await post(`/topic-claims/${requestId}/abort`, {});
    core.pruneTopicCreateClaims(Date.now() + 29 * DAY);
    expect(getTopicCreateClaim("loopback", requestId)?.state).toBe("aborted");
    // Several expired rows exist in the shared store; drain in bounded batches.
    for (let i = 0; i < 50 && getTopicCreateClaim("loopback", requestId); i += 1) {
      core.pruneTopicCreateClaims(Date.now() + 31 * DAY);
    }
    expect(getTopicCreateClaim("loopback", requestId)).toBeNull();
  });

  test("pruning is bounded per call", () => {
    const now = new Date(Date.now() - 40 * DAY).toISOString();
    for (let i = 0; i < 5; i += 1) {
      db.query(
        `INSERT INTO api_topic_create_claims
           (principal_key, request_id, op, payload_hash, topic_id, state, node_id,
            seed_max_message_rowid, created_at, updated_at)
         VALUES ('loopback', ?, 'abort', '', NULL, 'aborted', NULL, 0, ?, ?)`,
      ).run(`bounded-${randomUUID()}`, now, now);
    }
    expect(core.pruneTopicCreateClaims(Date.now(), undefined, 2)).toBe(2);
  });
});

describe("follow-up D — identity is stamped into whichever store is current", () => {
  test("a store that lost its identity row is re-stamped on the next request", async () => {
    await call("/health");
    db.query("DELETE FROM api_node_identity").run();
    expect(topicLinkNodeIdentity()).toBeNull();
    const health = await call("/health");
    expect(topicLinkNodeIdentity()).toBe(NODE_ID);
    expect(health.body.dbEpoch).toMatch(/^[0-9a-f]{32}$/);
  });
});
