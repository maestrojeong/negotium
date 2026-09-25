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
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { createDefaultSessionCommMcpHost } from "#mcp/session-comm/default-host";
import { setRemoteSessionHubFetch } from "#mcp/session-comm/hub-remote-session";
import { setRemoteSessionAskReplyDeliverer } from "#runtime/remote-session-inbox";
import { runRemoteSessionMaintenance } from "#runtime/remote-session-reply-outbox";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import * as remoteSession from "#storage/remote-session";
import {
  createPendingAsk,
  listPendingAsksForCaller,
  PENDING_ASK_TTL_MS,
} from "#storage/session-asks";
import { resolveStorageSessionAsksDir } from "#storage/storage-host";
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
    defaultModel: "gpt-6-luna",
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

  test("a fresh dispatched row (hub call may be in flight) and a fresh prepared one are kept", async () => {
    const sent = makeTopic();
    const fresh = makeTopic();
    const now = Date.now();
    const sentId = leftBehind(sent, "dispatched", now - 30_000);
    const freshId = leftBehind(fresh, "prepared", now - 1_000);

    await runRemoteSessionMaintenance(now);

    expect(getRemoteSessionAsk(sentId)?.dispatchState).toBe("dispatched");
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
    const newerId = leftBehind(room, "dispatched", now - 1_000);

    await runRemoteSessionMaintenance(now);

    expect(getRemoteSessionAsk(staleId)).toBeNull();
    expect(markers(room)).toEqual([newerId]);
    expect(getRemoteSessionAsk(newerId)).not.toBeNull();
  });
});

/*
 * PR9 final review (availability): row and marker are ONE state machine.
 * (a) a marker that could not be released must never lose its row (the row is
 *     how reconciliation finds it again); (b) a process that died between
 *     `dispatched` and the hub call — or a call that ended uncertain — must not
 *     block the room for the whole TTL: the marker is released (`unknown`),
 *     the row kept for a late reply, and the caller told when none came.
 */
describe("outbound ask state machine: fault injection and recovery", () => {
  /** The caller's pending-marker directory (userId is filename-safe). */
  const markerDir = () => join(resolveStorageSessionAsksDir(), userId);
  const lockMarkers = () => chmodSync(markerDir(), 0o500);
  const unlockMarkers = () => chmodSync(markerDir(), 0o700);
  const notices: Array<{
    requestId: string;
    callerTopicId: string;
    label: string;
    body: string;
    kind: string;
  }> = [];

  afterEach(() => {
    try {
      unlockMarkers();
    } catch {
      // never created
    }
    setRemoteSessionAskReplyDeliverer(null);
    notices.splice(0);
  });

  function captureNotices(): void {
    setRemoteSessionAskReplyDeliverer(async (pending, label, body, kind, options) => {
      notices.push({
        requestId: pending.requestId,
        callerTopicId: pending.callerTopicId,
        label,
        body,
        kind,
      });
      options?.onRecorded?.();
      return true;
    });
  }

  function state(requestId: string): string | null | undefined {
    const row = db
      .query<{ dispatch_state: string }, [string]>(
        "SELECT dispatch_state FROM remote_session_asks WHERE request_id = ?",
      )
      .get(requestId);
    return row ? row.dispatch_state : null;
  }

  function persisted(topic: TopicDto, dispatchState: string, createdAt: number): string {
    const requestId = `crash-${randomUUID()}`;
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

  test("(a) marker release throws after a failed dispatch: the row is kept with its marker, then reconciled together", async () => {
    const room = makeTopic();
    const requestId = `throwing-release-${randomUUID()}`;
    failAskWrites(room.id, "UPDATE");
    const release = () => {
      throw new Error("injected marker release failure");
    };
    expect(() =>
      remoteSession.beginRemoteSessionAsk({
        requestId,
        callerTopicId: room.id,
        userId,
        fromKey: `agent:${room.title}`,
        toKey: TARGET,
        createMarker: () =>
          createPendingAsk({ userId, from: `agent:${room.title}`, to: TARGET, requestId }).ok,
        releaseMarker: release,
        clearMarker: release, // the pre-fix name of the same callback
      } as Parameters<typeof remoteSession.beginRemoteSessionAsk>[0]),
    ).toThrow();

    // Never a lone marker: the row that lets reconciliation find it survives.
    expect(markers(room)).toEqual([requestId]);
    expect(state(requestId)).toBe("prepared");

    for (const name of triggers.splice(0)) db.run(`DROP TRIGGER IF EXISTS ${name}`);
    await runRemoteSessionMaintenance(Date.now() + 2 * 60_000);
    expect(state(requestId)).toBeNull();
    expect(markers(room)).toEqual([]);
  });

  test("(a) hub refuses and the marker cannot be unlinked: row parked `abandoned`, released on the next pass; the room can ask again", async () => {
    const host = createDefaultSessionCommMcpHost();
    const room = makeTopic();
    mkdirSync(markerDir(), { recursive: true });
    hubCalls = 0;
    setRemoteSessionHubFetch(async () => {
      hubCalls += 1;
      lockMarkers(); // the marker exists now; its unlink will fail
      return Response.json({ error: "no such session" }, { status: 404 });
    });

    const refused = await host.askSession(scoped(room), { to: TARGET, message: "?" });
    expect(isError(refused)).toBe(true);
    const [requestId] = markers(room);
    expect(requestId).toBeDefined();
    // Pre-fix: the row was deleted anyway → a marker nothing can find.
    expect(state(requestId!)).toBe("abandoned");

    // Still unremovable: the pass keeps the row (retry-safe), nothing lost.
    await runRemoteSessionMaintenance(Date.now());
    expect(state(requestId!)).toBe("abandoned");
    expect(markers(room)).toEqual([requestId!]);

    unlockMarkers();
    await runRemoteSessionMaintenance(Date.now());
    expect(state(requestId!)).toBeNull();
    expect(markers(room)).toEqual([]);

    stubHubAccepts();
    expect(isError(await host.askSession(scoped(room), { to: TARGET, message: "?" }))).toBe(false);
  });

  test("(b) crash between `dispatched` and the hub call: recovery releases the marker, keeps the row `unknown`, the room can ask again", async () => {
    const room = makeTopic();
    const now = Date.now();
    const requestId = persisted(room, "dispatched", now - 3 * 60_000);

    await runRemoteSessionMaintenance(now);

    expect(markers(room)).toEqual([]);
    expect(state(requestId)).toBe("unknown");
    // A late reply is still routed: the reply path sees the row.
    expect(getRemoteSessionAsk(requestId)?.callerTopicId).toBe(room.id);

    stubHubAccepts();
    const again = await createDefaultSessionCommMcpHost().askSession(scoped(room), {
      to: TARGET,
      message: "?",
    });
    expect(isError(again)).toBe(false);
    expect(hubCalls).toBe(1);
  });

  test("(b) recovery is idempotent, and the caller is told exactly once when no reply ever arrives", async () => {
    captureNotices();
    const room = makeTopic();
    const now = Date.now();
    const createdAt = now - 3 * 60_000;
    const requestId = persisted(room, "dispatched", createdAt);

    await runRemoteSessionMaintenance(now);
    await runRemoteSessionMaintenance(now);
    await runRemoteSessionMaintenance(now + 1_000);
    expect(state(requestId)).toBe("unknown");
    expect(markers(room)).toEqual([]);
    expect(notices).toEqual([]);

    const afterTtl = createdAt + PENDING_ASK_TTL_MS + 1;
    await runRemoteSessionMaintenance(afterTtl);
    await runRemoteSessionMaintenance(afterTtl + 5_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      requestId,
      callerTopicId: room.id,
      label: TARGET,
      kind: "error",
    });
    expect(notices[0]!.body).toContain("No reply arrived");
    expect(notices[0]!.body).toContain(requestId);
    expect(state(requestId)).toBeNull();
  });

  test("(b) a notice that cannot be recorded is retried; a late reply in flight wins over the notice", async () => {
    const room = makeTopic();
    const now = Date.now();
    const createdAt = now - PENDING_ASK_TTL_MS - 1_000;
    const failing = persisted(room, "unknown", createdAt);
    const replying = `reply-in-flight-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId: replying,
      callerTopicId: room.id,
      userId,
      fromKey: `agent:${room.title}`,
      toKey: "other/Room",
      createdAt,
      dispatchState: "unknown",
    } as Parameters<typeof recordRemoteSessionAsk>[0]);
    remoteSession.claimRemoteSessionInbox({
      requestId: replying,
      kind: "ask-reply",
      topicId: room.id,
      payloadHash: "late-reply",
      now,
    });

    setRemoteSessionAskReplyDeliverer(async () => false);
    await runRemoteSessionMaintenance(now);
    // Not recorded: kept (now invisible to the reply path) for the next pass.
    expect(state(failing)).toBe("expired");
    expect(getRemoteSessionAsk(failing)).toBeNull();
    // The late reply holds its claim: no notice races it, the row stays answerable.
    expect(state(replying)).toBe("unknown");
    expect(getRemoteSessionAsk(replying)).not.toBeNull();

    captureNotices();
    await runRemoteSessionMaintenance(now + 5_000);
    expect(notices.map((notice) => notice.requestId)).toEqual([failing]);
    expect(state(failing)).toBeNull();
    db.run("DELETE FROM remote_session_inbox_claims WHERE request_id = ?", [replying]);
  });

  test("marker release fails during recovery: the row stays `dispatched` (retry-safe) until it succeeds", async () => {
    const room = makeTopic();
    const now = Date.now();
    const requestId = persisted(room, "dispatched", now - 3 * 60_000);

    lockMarkers();
    await runRemoteSessionMaintenance(now);
    expect(state(requestId)).toBe("dispatched");
    expect(markers(room)).toEqual([requestId]);

    unlockMarkers();
    await runRemoteSessionMaintenance(now);
    expect(state(requestId)).toBe("unknown");
    expect(markers(room)).toEqual([]);
  });

  test("the legitimate path is unchanged: an acknowledged ask keeps row + marker until its reply, untouched by recovery", async () => {
    stubHubAccepts();
    const host = createDefaultSessionCommMcpHost();
    const room = makeTopic();
    expect(isError(await host.askSession(scoped(room), { to: TARGET, message: "?" }))).toBe(false);
    const [requestId] = markers(room);
    expect(state(requestId!)).toBe("sent");

    await runRemoteSessionMaintenance(Date.now() + 3 * 60_000);
    expect(state(requestId!)).toBe("sent");
    expect(markers(room)).toEqual([requestId!]);
    expect(
      JSON.stringify(await host.askSession(scoped(room), { to: TARGET, message: "?" })),
    ).toContain("already pending");
  });
});
