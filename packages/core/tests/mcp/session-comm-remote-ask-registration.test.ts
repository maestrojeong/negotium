/**
 * PR9 review (availability): an outbound hub ask writes two things — the
 * caller's pending marker (a file) and the durable `remote_session_asks` row.
 *
 * The bug this pins: the marker was created first and the row written after
 * it with no error handling. A throwing row write (or a crash in between) left
 * only the marker, which blocks every further ask from the same room to the
 * same target until the 15 min TTL; a crash before the hub call left an
 * orphan row + marker nobody would ever answer.
 *
 * Now: row (`prepared`) → marker → `dispatched` → hub call, every failure
 * undoes both, and the maintenance pass (which also runs at startup) removes
 * a `prepared` row a dead process left behind, together with its marker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { createDefaultSessionCommMcpHost } from "#mcp/session-comm/default-host";
import { setRemoteSessionHubFetch } from "#mcp/session-comm/hub-remote-session";
import { runRemoteSessionMaintenance } from "#runtime/remote-session-reply-outbox";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import * as remoteSession from "#storage/remote-session";
import { createPendingAsk, listPendingAsksForCaller } from "#storage/session-asks";
import type { TopicDto } from "#types/api";

const { getRemoteSessionAsk, recordRemoteSessionAsk } = remoteSession;

const userId = `remote-ask-registration-${randomUUID()}`;
const createdTopicIds: string[] = [];
const triggers: string[] = [];
const grant = { hubUrl: "https://hub.example", capability: "rsc1.cGF5bG9hZA.c2lnbmF0dXJl" };
const TARGET = "gmovie/Render";

function makeTopic(): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `remote-ask-registration-${randomUUID()}`,
    title: `Remote Ask ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    aiMention: false,
    participants: [{ userId, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    surface: "otium",
    surfaceScope: `ws-hub-${randomUUID()}`,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

function scoped(topic: TopicDto): SessionCommContext {
  return {
    userId,
    currentTopic: topic.title,
    currentTopicId: topic.id,
    depth: 0,
    replyOnly: false,
    agent: "codex",
    actorUserId: "person",
    actorTopicScope: {
      visibleNodeTopicIds: [topic.id],
      ownedNodeTopicIds: [],
      issuedAt: Date.now(),
    },
    remoteSession: grant,
  };
}

/** Make the next matching write to `remote_session_asks` fail, like a full/locked DB. */
function failAskWrites(topicId: string, on: "INSERT" | "UPDATE"): void {
  const name = `fail_remote_ask_${on.toLowerCase()}_${randomUUID().replaceAll("-", "")}`;
  db.run(
    `CREATE TEMP TRIGGER ${name} BEFORE ${on} ON remote_session_asks
     WHEN NEW.caller_topic_id = '${topicId}'
     BEGIN SELECT RAISE(ABORT, 'injected remote_session_asks failure'); END`,
  );
  triggers.push(name);
}

function markers(topic: TopicDto): string[] {
  return listPendingAsksForCaller({ userId, from: `agent:${topic.title}` })
    .filter((ask) => ask.to === TARGET)
    .map((ask) => ask.requestId);
}

function rows(topicId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM remote_session_asks WHERE caller_topic_id = ?",
      )
      .get(topicId)?.n ?? 0
  );
}

function isError(result: unknown): boolean {
  return Boolean((result as { isError?: boolean }).isError);
}

let hubCalls = 0;
function stubHubAccepts(): void {
  hubCalls = 0;
  setRemoteSessionHubFetch(async () => {
    hubCalls += 1;
    return Response.json({ ok: true, v: 1, replayed: false }, { status: 202 });
  });
}

afterEach(() => {
  setRemoteSessionHubFetch(null);
  for (const name of triggers.splice(0)) db.run(`DROP TRIGGER IF EXISTS ${name}`);
  for (const id of createdTopicIds.splice(0)) {
    db.run("DELETE FROM remote_session_asks WHERE caller_topic_id = ?", [id]);
    deleteTopic(id);
  }
});

describe("registering an outbound hub ask never leaves a lone marker or row", () => {
  test("the durable row write throws: tool error, no marker, no row, nothing sent; the next ask is not blocked", async () => {
    stubHubAccepts();
    const host = createDefaultSessionCommMcpHost();
    const room = makeTopic();
    failAskWrites(room.id, "INSERT");

    // (Pre-fix the storage error escaped the tool; either way nothing may be
    // left behind.)
    const failed = await Promise.resolve()
      .then(() => host.askSession(scoped(room), { to: TARGET, message: "?" }))
      .catch(() => ({ isError: true, thrown: true }));
    expect(markers(room)).toEqual([]);
    expect(failed).not.toHaveProperty("thrown");
    expect(isError(failed)).toBe(true);
    expect(markers(room)).toEqual([]);
    expect(rows(room.id)).toBe(0);
    expect(hubCalls).toBe(0);

    for (const name of triggers.splice(0)) db.run(`DROP TRIGGER IF EXISTS ${name}`);
    const retried = await host.askSession(scoped(room), { to: TARGET, message: "?" });
    expect(isError(retried)).toBe(false);
    expect(markers(room)).toHaveLength(1);
    expect(rows(room.id)).toBe(1);
    expect(hubCalls).toBe(1);
  });

  test("the write after the marker (dispatch) throws: the marker is withdrawn with the row", async () => {
    stubHubAccepts();
    const host = createDefaultSessionCommMcpHost();
    const room = makeTopic();
    failAskWrites(room.id, "UPDATE");

    const failed = await host.askSession(scoped(room), { to: TARGET, message: "?" });
    expect(isError(failed)).toBe(true);
    expect(markers(room)).toEqual([]);
    expect(rows(room.id)).toBe(0);
    expect(hubCalls).toBe(0);
  });

  test("an already-pending ask to the same room leaves no row behind", async () => {
    stubHubAccepts();
    const host = createDefaultSessionCommMcpHost();
    const room = makeTopic();
    expect(isError(await host.askSession(scoped(room), { to: TARGET, message: "1" }))).toBe(false);
    const second = await host.askSession(scoped(room), { to: TARGET, message: "2" });
    expect(isError(second)).toBe(true);
    expect(JSON.stringify(second)).toContain("already pending");
    expect(rows(room.id)).toBe(1);
    expect(hubCalls).toBe(1);
  });
});

describe("reconciliation of asks a dead process never sent", () => {
  function leftBehind(
    topic: TopicDto,
    dispatchState: "prepared" | "dispatched",
    createdAt: number,
  ): string {
    const requestId = `left-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId,
      callerTopicId: topic.id,
      userId,
      fromKey: `agent:${topic.title}`,
      toKey: TARGET,
      createdAt,
      dispatchState,
    } as Parameters<typeof recordRemoteSessionAsk>[0]);
    expect(
      createPendingAsk({ userId, from: `agent:${topic.title}`, to: TARGET, requestId }).ok,
    ).toBe(true);
    return requestId;
  }

  test("a prepared row past the grace is removed with its marker; the room can ask again", async () => {
    const room = makeTopic();
    const now = Date.now();
    const requestId = leftBehind(room, "prepared", now - 2 * 60_000);

    await runRemoteSessionMaintenance(now);

    expect(getRemoteSessionAsk(requestId)).toBeNull();
    expect(markers(room)).toEqual([]);
    stubHubAccepts();
    const asked = await createDefaultSessionCommMcpHost().askSession(scoped(room), {
      to: TARGET,
      message: "?",
    });
    expect(isError(asked)).toBe(false);
  });

  test("a dispatched row (the hub may hold it) and a fresh prepared one are kept", async () => {
    const sent = makeTopic();
    const fresh = makeTopic();
    const now = Date.now();
    const sentId = leftBehind(sent, "dispatched", now - 2 * 60_000);
    const freshId = leftBehind(fresh, "prepared", now - 1_000);

    await runRemoteSessionMaintenance(now);

    expect(getRemoteSessionAsk(sentId)).not.toBeNull();
    expect(markers(sent)).toEqual([sentId]);
    expect(getRemoteSessionAsk(freshId)).not.toBeNull();
    expect(markers(fresh)).toEqual([freshId]);
  });

  test("a stale prepared row never clears a newer ask's marker to the same room", async () => {
    const room = makeTopic();
    const now = Date.now();
    const staleId = `stale-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId: staleId,
      callerTopicId: room.id,
      userId,
      fromKey: `agent:${room.title}`,
      toKey: TARGET,
      createdAt: now - 2 * 60_000,
      dispatchState: "prepared",
    } as Parameters<typeof recordRemoteSessionAsk>[0]);
    const newerId = leftBehind(room, "dispatched", now);

    await runRemoteSessionMaintenance(now);

    expect(getRemoteSessionAsk(staleId)).toBeNull();
    expect(markers(room)).toEqual([newerId]);
    expect(getRemoteSessionAsk(newerId)).not.toBeNull();
  });
});
