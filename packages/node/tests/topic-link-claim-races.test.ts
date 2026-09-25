/**
 * PR7 review fixes — concurrency regressions for the topic-link claim paths.
 *
 * "Another process" is a second SQLite connection on the same database file
 * (exactly what a second node process is to SQLite: its own connection, its
 * own locks). Interleavings are forced with promise gates, not timing:
 *
 * - the delete cascade is paused inside `deleteFilesForTopic` (after the
 *   abort's checks and the archive, before messages are deleted) through the
 *   public `setFileHooks` seam, which both the old and the fixed code call;
 * - a create in "another process" commits right before the abort decides;
 * - the losing create/derive of a same-key race runs its insert after the
 *   winner's claim committed on the other connection.
 */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendApiMessage,
  asMessageId,
  asTopicId,
  asUserId,
  deleteTopicCascade,
  fileHooks,
  getApiMessage,
  getTopic,
  getTopicCreateClaim,
  listTopics,
  NODE_CONTROL_TOKEN,
  registerTopic,
  setFileHooks,
  topicLinkPayloadHash,
  topicService,
} from "@negotium/core";
import {
  insertCommittedTopicCreateClaim,
  markTopicCreateClaimAborted,
} from "@negotium/core/node-host";
import { createNodeControlHandler, NODE_CONTROL_BASE_PATH } from "../src/control";
import * as topicLink from "../src/topic-link";

const userId = `topic-link-race-${randomUUID()}`;
const handler = createNodeControlHandler({
  port: () => 43219,
  startedAt: "2026-09-25T00:00:00.000Z",
  requestShutdown() {},
});

const dbPath = process.env.SESSIONS_DB_PATH as string;
/** A second connection: another node process as far as SQLite is concerned. */
const other = new Database(dbPath);
other.exec("PRAGMA busy_timeout = 5000");

const originalFileHooks = fileHooks();
type AbortHooks = {
  beforeDecide?: () => void | Promise<void>;
  afterFence?: (topicId: string) => void | Promise<void>;
};
// Namespace access so this file still loads against the pre-fix module.
const abortHooks = (topicLink as unknown as { topicLinkAbortTestHooks?: AbortHooks })
  .topicLinkAbortTestHooks;

afterEach(() => {
  setFileHooks(originalFileHooks);
  if (abortHooks) {
    delete abortHooks.beforeDecide;
    delete abortHooks.afterFence;
  }
});

afterAll(async () => {
  other.close();
  for (const topic of listTopics()) {
    if (!topic.participants.some((participant) => participant.userId === userId)) continue;
    await deleteTopicCascade(topic, userId).catch(() => {});
  }
});

function runtime(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:43219${NODE_CONTROL_BASE_PATH}/runtime/v1${path}`, {
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

function post(path: string, body: unknown) {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

function createBody(title: string, requestId?: string) {
  const body: Record<string, unknown> = { v: 1, userId, title, kind: "agent", agent: "codex" };
  if (requestId) body.requestId = requestId;
  return body;
}

async function claimedRoom(requestId = randomUUID()) {
  const created = await post("/topics", createBody(`Race ${randomUUID()}`, requestId));
  expect(created.status).toBe(201);
  return { requestId, topicId: created.body.topic.id as string };
}

/** Pause the delete cascade of one topic after the archive, before messages are deleted. */
function gateCascade(topicId: string) {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  setFileHooks({
    ...originalFileHooks,
    async deleteFilesForTopic(id) {
      if (id === topicId) {
        reached();
        await releasePromise;
      }
      await originalFileHooks.deleteFilesForTopic?.(id);
    },
  });
  return { reached: reachedPromise, release };
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

function messageRow(id: string) {
  return other.query("SELECT id, topic_id FROM api_messages WHERE id = ?").get(id);
}

describe("fix 1 — no message is lost to a claim abort", () => {
  test("a gateway turn arriving while the abort deletes is refused, never accepted then deleted", async () => {
    const { requestId, topicId } = await claimedRoom();
    const gate = gateCascade(topicId);
    const aborting = post(`/topic-claims/${requestId}/abort`, {});
    await gate.reached;

    const clientMessageId = randomUUID();
    const turn = await post("/turns", {
      v: 1,
      topicId,
      userId,
      text: "written while the room was being aborted",
      clientMessageId,
      respond: false,
    });
    gate.release();
    const aborted = await aborting;

    // The invariant: an accepted message is never deleted.
    if (turn.status < 300) {
      expect(getApiMessage(topicId, turn.body.messageId)).toBeTruthy();
    }
    expect(turn.status).toBe(409);
    expect(turn.body.code).toBe("topic_unavailable");
    expect(aborted.status).toBe(200);
    expect(aborted.body).toMatchObject({ aborted: true, topicDeleted: true, topicId });
    expect(getTopic(topicId)).toBeNull();
  });

  test("a message from another process between the check and the delete is refused by SQLite", async () => {
    const { requestId, topicId } = await claimedRoom();
    const gate = gateCascade(topicId);
    const aborting = post(`/topic-claims/${requestId}/abort`, {});
    await gate.reached;

    const id = randomUUID();
    let insertError: unknown = null;
    try {
      other
        .query(
          "INSERT INTO api_messages (id, topic_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, topicId, userId, "other process", new Date().toISOString());
    } catch (error) {
      insertError = error;
    }
    // Same process, the canonical append path.
    const local = message(topicId, "same process");
    let localError: unknown = null;
    try {
      appendApiMessage(local, { notify: false });
    } catch (error) {
      localError = error;
    }
    gate.release();
    const aborted = await aborting;

    // Accepted ⇒ still there. Refused ⇒ the writer was told.
    if (!insertError) expect(messageRow(id)).toBeTruthy();
    if (!localError) expect(messageRow(local.id)).toBeTruthy();
    expect(String(insertError)).toContain("topic_claim_abort_in_progress");
    expect(String(localError)).toContain("topic_claim_abort_in_progress");
    expect(aborted.body).toMatchObject({ topicDeleted: true });
  });

  test("a message that still lands (stale fence) vetoes the delete: topic and message kept, claim committed", async () => {
    const { requestId, topicId } = await claimedRoom();
    const gate = gateCascade(topicId);
    const aborting = post(`/topic-claims/${requestId}/abort`, {});
    await gate.reached;

    // The fence went stale (e.g. the aborting process stalled): the trigger no
    // longer refuses, so only the in-transaction re-check can save the message.
    other.query("UPDATE runtime_topic_state SET heartbeat_at = 0 WHERE topic_id = ?").run(topicId);
    const late = message(topicId, "landed on a stale fence");
    appendApiMessage(late, { notify: false });
    gate.release();
    const aborted = await aborting;

    expect(messageRow(late.id)).toBeTruthy();
    expect(getTopic(topicId)).not.toBeNull();
    expect(aborted.status).toBe(409);
    expect(aborted.body.code).toBe("claim_topic_has_messages");
    expect(getTopicCreateClaim("loopback", requestId)?.state).toBe("committed");
    // The room is usable again: the maintenance fence was released.
    appendApiMessage(message(topicId, "after the veto"), { notify: false });
  });
});

describe("fix 3 — an abort never orphans a freshly committed create", () => {
  test("the storage primitive never flips a committed claim whose topic lives", async () => {
    const { requestId, topicId } = await claimedRoom();
    const claim = markTopicCreateClaimAborted("loopback", requestId);
    const live = getTopic(topicId);
    // Never: aborted claim + live topic (replay refused, room orphaned).
    expect(claim.state === "aborted" && live !== null).toBe(false);
    expect(claim.state).toBe("committed");
  });

  test("a create committed by another process right before the abort decides is deleted, not orphaned", async () => {
    expect(abortHooks).toBeDefined();
    const requestId = randomUUID();
    const title = `Committed elsewhere ${randomUUID()}`;
    let createdId = "";
    if (abortHooks) {
      abortHooks.beforeDecide = () => {
        // The other process's create transaction: topic row + claim, together.
        const body = createBody(title, requestId);
        const topic = registerTopic({
          title,
          userId,
          kind: "agent",
          agent: "codex",
          // The create's own transaction (topic row + claim together). It
          // commits before the abort's BEGIN IMMEDIATE opens — the window the
          // pre-fix code left between "no claim" and writing the fence.
          withinCreateTransaction: (created) => {
            insertCommittedTopicCreateClaim({
              principalKey: "loopback",
              requestId,
              op: "create",
              payloadHash: topicLinkPayloadHash(body),
              topicId: created.id,
            });
          },
        });
        createdId = topic.id;
      };
    }
    const aborted = await post(`/topic-claims/${requestId}/abort`, {});
    expect(createdId).not.toBe("");
    expect(aborted.status).toBe(200);
    expect(aborted.body).toMatchObject({
      aborted: true,
      existed: true,
      topicDeleted: true,
      topicId: createdId,
    });
    expect(getTopic(createdId)).toBeNull();
    expect(getTopicCreateClaim("loopback", requestId)?.state).toBe("aborted");
  });

  test("an abort fence committed by another process first makes the create a 409 with no room", async () => {
    const requestId = randomUUID();
    const title = `Fenced elsewhere ${randomUUID()}`;
    const link = topicLink.parseTopicLinkRequest(
      runtime("/topics"),
      createBody(title, requestId),
      "create",
      createBody(title, requestId),
    );
    if (!link || link instanceof Response) throw new Error("expected a link request");
    const response = await topicLink.runClaimedTopicCreate(
      link,
      runtime("/topics"),
      async (within) => {
        other
          .query(
            `INSERT INTO api_topic_create_claims
             (principal_key, request_id, op, payload_hash, topic_id, state, node_id,
              seed_max_message_rowid, created_at, updated_at)
           VALUES ('loopback', ?, 'abort', '', NULL, 'aborted', NULL, 0, ?, ?)`,
          )
          .run(requestId, new Date().toISOString(), new Date().toISOString());
        return topicService.create({
          title,
          userId,
          kind: "agent",
          agent: "codex",
          withinCreateTransaction: within,
        });
      },
    );
    expect(response?.status).toBe(409);
    expect(((await response?.json()) as { code: string }).code).toBe("request_aborted");
    expect(listTopics().filter((topic) => topic.title === title)).toHaveLength(0);
  });
});

describe("fix 4 — the loser of a cross-process same-key race gets the replay 201", () => {
  function commitWinnerClaim(
    requestId: string,
    op: "create" | "derive",
    hash: string,
    topicId: string,
  ) {
    other
      .query(
        `INSERT INTO api_topic_create_claims
           (principal_key, request_id, op, payload_hash, topic_id, state, node_id,
            seed_max_message_rowid, created_at, updated_at)
         VALUES ('loopback', ?, ?, ?, ?, 'committed', NULL, 0, ?, ?)`,
      )
      .run(requestId, op, hash, topicId, new Date().toISOString(), new Date().toISOString());
  }

  test("create", async () => {
    const requestId = randomUUID();
    const title = `Loser create ${randomUUID()}`;
    const body = createBody(title, requestId);
    const link = topicLink.parseTopicLinkRequest(runtime("/topics"), body, "create", body);
    if (!link || link instanceof Response) throw new Error("expected a link request");
    // The winner's room (committed by the other process).
    const winner = registerTopic({
      title: `Winner create ${randomUUID()}`,
      userId,
      kind: "agent",
      agent: "codex",
    });
    const response = await topicLink.runClaimedTopicCreate(
      link,
      runtime("/topics"),
      async (within) => {
        commitWinnerClaim(requestId, "create", link.payloadHash, winner.id);
        return topicService.create({
          title,
          userId,
          kind: "agent",
          agent: "codex",
          withinCreateTransaction: within,
        });
      },
    );
    expect(response?.status).toBe(201);
    const answer = (await response?.json()) as Record<string, any>;
    expect(answer).toMatchObject({ requestId, replayed: true });
    expect(answer.topic.id).toBe(winner.id);
    expect(listTopics().filter((topic) => topic.title === title)).toHaveLength(0);
  });

  test("derive", async () => {
    const source = await post("/topics", createBody(`Race source ${randomUUID()}`));
    const sourceId = source.body.topic.id as string;
    const requestId = randomUUID();
    const name = `Loser derive ${randomUUID()}`;
    const body = { v: 1, userId, copyHistory: false, name, requestId };
    const link = topicLink.parseTopicLinkRequest(
      runtime(`/topics/${sourceId}/derive`),
      body,
      "derive",
      {
        sourceTopicId: sourceId,
        ...body,
      },
    );
    if (!link || link instanceof Response) throw new Error("expected a link request");
    const winner = registerTopic({
      title: `Winner derive ${randomUUID()}`,
      userId,
      kind: "agent",
      agent: "codex",
    });
    const response = await topicLink.runClaimedTopicCreate(
      link,
      runtime("/topics"),
      async (within) => {
        commitWinnerClaim(requestId, "derive", link.payloadHash, winner.id);
        return topicService.derive({
          sourceTopicId: sourceId,
          userId,
          copyHistory: false,
          name,
          withinCreateTransaction: within,
        });
      },
    );
    // Pre-fix: derive swallowed the PK error, returned null → the route's 500.
    expect(response).not.toBeNull();
    expect(response?.status).toBe(201);
    const answer = (await response?.json()) as Record<string, any>;
    expect(answer).toMatchObject({ requestId, replayed: true });
    expect(answer.topic.id).toBe(winner.id);
    expect(listTopics().filter((topic) => topic.title === name)).toHaveLength(0);
  });
});
