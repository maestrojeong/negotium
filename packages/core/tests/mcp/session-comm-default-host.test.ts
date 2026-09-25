import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { createDefaultSessionCommMcpHost } from "#mcp/session-comm/default-host";
import {
  type RemoteSessionHubFetch,
  setRemoteSessionHubFetch,
} from "#mcp/session-comm/hub-remote-session";
import {
  type PeerForwardArgs,
  type PeerSessionBridge,
  registerPeerSessionBridge,
} from "#mcp/session-comm/peer-forward";
import { setNodeMcpServers } from "#platform/mcp-config";
import { sessionInboxPath } from "#query/session-inbox-path";
import { getApiTopicConfig } from "#storage/api-topic-config";
import { deleteTopic, grantSubagentTellTarget, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { getRemoteSessionAsk } from "#storage/remote-session";
import { listPendingAsksForCaller } from "#storage/session-asks";
import type { TopicDto } from "#types/api";

const userId = `session-default-host-${randomUUID()}`;
const createdTopicIds: string[] = [];
const inboxPaths: string[] = [];

function makeTopic(patch: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `session-default-topic-${randomUUID()}`,
    title: `Session Default ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    aiMention: false,
    participants: [{ userId, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    ...patch,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

function context(topic: TopicDto): SessionCommContext {
  return {
    userId,
    currentTopic: topic.title,
    currentTopicId: topic.id,
    depth: 0,
    replyOnly: false,
    agent: "codex",
  };
}

/** Capture what the host sends to the hub, answering with `respond`. */
function stubHub(respond: (op: string, body: Record<string, unknown>) => Response | never) {
  const calls: Array<{ op: string; authorization: string | null; body: Record<string, unknown> }> =
    [];
  const stub: RemoteSessionHubFetch = async (url, init) => {
    const op = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ op, authorization: new Headers(init.headers).get("authorization"), body });
    return respond(op, body);
  };
  setRemoteSessionHubFetch(stub);
  return calls;
}

const grant = { hubUrl: "https://hub.example", capability: "rsc1.cGF5bG9hZA.c2lnbmF0dXJl" };

afterEach(() => {
  setRemoteSessionHubFetch(null);
  setNodeMcpServers([]);
  for (const path of inboxPaths.splice(0)) {
    if (existsSync(path)) unlinkSync(path);
  }
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

describe("default session-comm MCP host", () => {
  test("persists a node-assigned MCP in the topic whitelist", async () => {
    const topic = makeTopic();
    setNodeMcpServers([{ key: "linear", kind: "stdio", command: "linear-mcp" }]);

    const result = await createDefaultSessionCommMcpHost().configureMcp(context(topic), [
      "linear",
      "wiki",
    ]);

    expect("isError" in result ? result.isError : false).not.toBe(true);
    expect(getApiTopicConfig(topic.id)?.mcp).toEqual(["linear"]);
  });

  test("writes tell_session messages to the target inbox", async () => {
    const source = makeTopic();
    const target = makeTopic();
    const inboxPath = sessionInboxPath(userId, target.id);
    inboxPaths.push(inboxPath);

    const result = await createDefaultSessionCommMcpHost().tellSession(context(source), {
      to: target.title,
      message: "hosted hello",
    });

    expect("isError" in result ? result.isError : false).not.toBe(true);
    const entries = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence",
      )
      .all(target.id)
      .map((row) => JSON.parse(row.payload));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "tell",
      fromTopicId: source.id,
      message: "hosted hello",
      depth: 1,
    });
  });

  test("on Otium the hub's assertion decides which workspace rooms a person may address", async () => {
    // Every hub-backed room holds the execution principal (this suite's
    // `userId`), so a roster check alone would reach all of them.
    const scope = `ws-scoped-${randomUUID()}`;
    const current = makeTopic({ surface: "otium", surfaceScope: scope });
    const invited = makeTopic({ surface: "otium", surfaceScope: scope });
    const owned = makeTopic({ surface: "otium", surfaceScope: scope });
    const uninvited = makeTopic({ surface: "otium", surfaceScope: scope });
    inboxPaths.push(
      sessionInboxPath(userId, invited.id),
      sessionInboxPath(userId, owned.id),
      sessionInboxPath(userId, uninvited.id),
    );
    const scoped: SessionCommContext = {
      ...context(current),
      actorUserId: "person",
      actorTopicScope: {
        visibleNodeTopicIds: [current.id, invited.id, owned.id],
        ownedNodeTopicIds: [current.id, owned.id],
      },
    };
    const host = createDefaultSessionCommMcpHost();

    const listed = JSON.stringify(await host.listSessions(scoped));
    expect(listed).toContain(invited.title);
    expect(listed).toContain(owned.title);
    expect(listed).not.toContain(uninvited.title);
    const peeked = JSON.stringify(await host.peekSession(scoped));
    expect(peeked).toContain(invited.title);
    expect(peeked).not.toContain(uninvited.title);

    const told = await host.tellSession(scoped, { to: invited.title, message: "hi" });
    expect("isError" in told ? told.isError : false).not.toBe(true);
    const refusedTell = await host.tellSession(scoped, { to: uninvited.title, message: "hi" });
    expect("isError" in refusedTell ? refusedTell.isError : false).toBe(true);
    expect(JSON.stringify(refusedTell)).toContain("not found");
    const refusedAsk = await host.askSession(scoped, { to: uninvited.title, message: "?" });
    expect("isError" in refusedAsk ? refusedAsk.isError : false).toBe(true);

    // Visible is not owned: aborting someone else's room is refused with the
    // same "not found" a stranger would get, so the reply leaks nothing.
    const abortInvited = await host.abortSession(scoped, invited.title);
    expect("isError" in abortInvited ? abortInvited.isError : false).toBe(true);
    expect(JSON.stringify(abortInvited)).toContain("not found");
    const abortOwned = await host.abortSession(scoped, owned.title);
    expect("isError" in abortOwned ? abortOwned.isError : false).not.toBe(true);
    const inbox = (topicId: string) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence",
        )
        .all(topicId)
        .map((row) => JSON.parse(row.payload).type);
    expect(inbox(invited.id)).toEqual(["tell"]);
    expect(inbox(owned.id)).toEqual(["abort"]);
    expect(inbox(uninvited.id)).toEqual([]);
  });

  test("on Otium an asserted turn gets no subagent lineage on top of the assertion", async () => {
    const scope = `ws-lineage-${randomUUID()}`;
    const parent = makeTopic({ surface: "otium", surfaceScope: scope });
    const worker = makeTopic({
      surface: "otium",
      surfaceScope: scope,
      parentTopicId: parent.id,
      isSubagent: true,
    });
    const granted = makeTopic({ surface: "otium", surfaceScope: scope });
    grantSubagentTellTarget(worker.id, granted.id, parent.id);
    inboxPaths.push(
      sessionInboxPath(userId, parent.id),
      sessionInboxPath(userId, worker.id),
      sessionInboxPath(userId, granted.id),
    );
    const host = createDefaultSessionCommMcpHost();
    const inbox = (topicId: string) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence",
        )
        .all(topicId)
        .map((row) => JSON.parse(row.payload).type);

    // (a) A member of the shared parent who does not own it: the parent's
    // worker is not in their assertion, so it cannot be listed, told or
    // aborted — the parent's delegation lends them nothing.
    const member: SessionCommContext = {
      ...context(parent),
      actorUserId: "member",
      actorTopicScope: { visibleNodeTopicIds: [parent.id], ownedNodeTopicIds: [] },
    };
    expect(JSON.stringify(await host.listSessions(member))).not.toContain(worker.title);
    const memberTell = await host.tellSession(member, { to: worker.title, message: "hi" });
    expect("isError" in memberTell ? memberTell.isError : false).toBe(true);
    expect(JSON.stringify(memberTell)).toContain("not found");
    const memberAbort = await host.abortSession(member, worker.title);
    expect("isError" in memberAbort ? memberAbort.isError : false).toBe(true);
    expect(JSON.stringify(memberAbort)).toContain("not found");
    expect(inbox(worker.id)).toEqual([]);

    // (b) A person speaking from the worker room: an ancestor granted the
    // worker a room this person cannot see; the grant does not widen them.
    const fromWorker: SessionCommContext = {
      ...context(worker),
      actorUserId: "member",
      actorTopicScope: { visibleNodeTopicIds: [worker.id, parent.id], ownedNodeTopicIds: [] },
    };
    const listedFromWorker = JSON.stringify(await host.listSessions(fromWorker));
    expect(listedFromWorker).toContain(parent.title);
    expect(listedFromWorker).not.toContain(granted.title);
    const grantedTell = await host.tellSession(fromWorker, { to: granted.title, message: "hi" });
    expect("isError" in grantedTell ? grantedTell.isError : false).toBe(true);
    expect(JSON.stringify(grantedTell)).toContain("not found");
    const parentTell = await host.tellSession(fromWorker, { to: parent.title, message: "report" });
    expect("isError" in parentTell ? parentTell.isError : false).not.toBe(true);
    expect(inbox(granted.id)).toEqual([]);
    expect(inbox(parent.id)).toEqual(["tell"]);

    // (c) The parent's owner: the hub mirrors the worker with the parent's
    // roster and asserts it as owned, which is what allows the abort.
    const owner: SessionCommContext = {
      ...context(parent),
      actorUserId: "owner",
      actorTopicScope: {
        visibleNodeTopicIds: [parent.id, worker.id],
        ownedNodeTopicIds: [parent.id, worker.id],
      },
    };
    expect(JSON.stringify(await host.listSessions(owner))).toContain(worker.title);
    const ownerAbort = await host.abortSession(owner, worker.title);
    expect("isError" in ownerAbort ? ownerAbort.isError : false).not.toBe(true);
    expect(inbox(worker.id)).toEqual(["abort"]);
  });

  test("on Otium a turn no person started keeps its subagent lineage", async () => {
    const scope = `ws-actorless-${randomUUID()}`;
    const parent = makeTopic({ surface: "otium", surfaceScope: scope });
    const worker = makeTopic({
      surface: "otium",
      surfaceScope: scope,
      parentTopicId: parent.id,
      isSubagent: true,
    });
    const sibling = makeTopic({
      surface: "otium",
      surfaceScope: scope,
      parentTopicId: parent.id,
      isSubagent: true,
    });
    const granted = makeTopic({ surface: "otium", surfaceScope: scope });
    const unrelated = makeTopic({ surface: "otium", surfaceScope: scope });
    grantSubagentTellTarget(worker.id, granted.id, parent.id);
    inboxPaths.push(
      ...[parent, worker, sibling, granted, unrelated].map((t) => sessionInboxPath(userId, t.id)),
    );
    const host = createDefaultSessionCommMcpHost();
    const inbox = (topicId: string) =>
      db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence",
        )
        .all(topicId)
        .map((row) => JSON.parse(row.payload).type);

    // (d) The worker's own turn (spawned, no assertion) reports to its parent
    // and reaches what it was granted — and nothing else.
    const fromWorker = context(worker);
    const toParent = await host.tellSession(fromWorker, { to: parent.title, message: "done" });
    expect("isError" in toParent ? toParent.isError : false).not.toBe(true);
    const toGranted = await host.tellSession(fromWorker, { to: granted.title, message: "fyi" });
    expect("isError" in toGranted ? toGranted.isError : false).not.toBe(true);
    for (const other of [sibling, unrelated]) {
      const refused = await host.tellSession(fromWorker, { to: other.title, message: "no" });
      expect("isError" in refused ? refused.isError : false).toBe(true);
      expect(inbox(other.id)).toEqual([]);
    }
    expect(inbox(parent.id)).toEqual(["tell"]);
    expect(inbox(granted.id)).toEqual(["tell"]);

    // The parent's follow-up turn (no assertion) still sees and may stop the
    // workers it spawned, and only those.
    const fromParent = context(parent);
    const listed = JSON.stringify(await host.listSessions(fromParent));
    expect(listed).toContain(worker.title);
    expect(listed).toContain(sibling.title);
    expect(listed).not.toContain(unrelated.title);
    const abortWorker = await host.abortSession(fromParent, worker.title);
    expect("isError" in abortWorker ? abortWorker.isError : false).not.toBe(true);
    expect(inbox(worker.id)).toEqual(["abort"]);
    const abortUnrelated = await host.abortSession(fromParent, unrelated.title);
    expect("isError" in abortUnrelated ? abortUnrelated.isError : false).toBe(true);
  });

  test("on Otium a turn without a hub assertion reaches no other room", async () => {
    const scope = `ws-unasserted-${randomUUID()}`;
    const current = makeTopic({ surface: "otium", surfaceScope: scope });
    const sibling = makeTopic({ surface: "otium", surfaceScope: scope });
    inboxPaths.push(sessionInboxPath(userId, sibling.id));
    const host = createDefaultSessionCommMcpHost();

    const listed = JSON.stringify(await host.listSessions(context(current)));
    expect(listed).not.toContain(sibling.title);
    const refused = await host.tellSession(context(current), {
      to: sibling.title,
      message: "should not arrive",
    });
    expect("isError" in refused ? refused.isError : false).toBe(true);
    const aborted = await host.abortSession(context(current), sibling.title);
    expect("isError" in aborted ? aborted.isError : false).toBe(true);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM session_inbox WHERE topic_id = ?",
        )
        .get(sibling.id)?.n,
    ).toBe(0);
  });

  test("off Otium the node's own membership still decides, assertion or not", async () => {
    const current = makeTopic({ surface: "terminal" });
    const sibling = makeTopic({ surface: "terminal" });
    inboxPaths.push(sessionInboxPath(userId, sibling.id));
    const host = createDefaultSessionCommMcpHost();
    const listed = JSON.stringify(await host.listSessions(context(current)));
    expect(listed).toContain(sibling.title);
    const told = await host.tellSession(context(current), { to: sibling.title, message: "hi" });
    expect("isError" in told ? told.isError : false).not.toBe(true);
  });

  test("a room in one Otium workspace cannot address a room in another", async () => {
    const source = makeTopic({ surface: "otium", surfaceScope: "ws_alpha" });
    const sibling = makeTopic({ surface: "otium", surfaceScope: "ws_alpha" });
    const stranger = makeTopic({ surface: "otium", surfaceScope: "ws_beta" });
    inboxPaths.push(sessionInboxPath(userId, sibling.id), sessionInboxPath(userId, stranger.id));

    const host = createDefaultSessionCommMcpHost();
    // Even a hub assertion that (wrongly) names the other workspace's room does
    // not cross the workspace boundary: the assertion narrows, never widens.
    const asserted: SessionCommContext = {
      ...context(source),
      actorTopicScope: {
        visibleNodeTopicIds: [sibling.id, stranger.id],
        ownedNodeTopicIds: [],
      },
    };
    const listed = await host.listSessions(asserted);
    const rendered = JSON.stringify(listed);
    expect(rendered).toContain(sibling.title);
    // Same surface, different workspace: the boundary the whole feature exists
    // for. A leak here would let one customer's node reach another's rooms.
    expect(rendered).not.toContain(stranger.title);

    const refused = await host.tellSession(asserted, {
      to: stranger.title,
      message: "should not arrive",
    });
    expect("isError" in refused ? refused.isError : false).toBe(true);
    expect(existsSync(sessionInboxPath(userId, stranger.id))).toBe(false);
  });

  test("on Otium a room whose AI is off is not a target at all", async () => {
    const scope = `ws-agentless-${randomUUID()}`;
    const current = makeTopic({ surface: "otium", surfaceScope: scope });
    const humanOnly = makeTopic({
      surface: "otium",
      surfaceScope: scope,
      kind: "channel",
      agent: undefined,
      aiMode: "off",
    });
    const withAgent = makeTopic({ surface: "otium", surfaceScope: scope });
    const scoped: SessionCommContext = {
      ...context(current),
      actorUserId: "person",
      actorTopicScope: {
        visibleNodeTopicIds: [current.id, humanOnly.id, withAgent.id],
        ownedNodeTopicIds: [current.id, humanOnly.id, withAgent.id],
      },
    };
    const host = createDefaultSessionCommMcpHost();
    // Even though the hub asserts it, there is nothing to tell, ask or abort
    // there: it is left out of the listing and of the idle roster, and a
    // direct reference is "not found" rather than "has no AI agent".
    expect(JSON.stringify(await host.listSessions(scoped))).not.toContain(humanOnly.title);
    const peeked = JSON.stringify(await host.peekSession(scoped));
    expect(peeked).toContain(withAgent.title);
    expect(peeked).not.toContain(humanOnly.title);
    const told = await host.tellSession(scoped, { to: humanOnly.title, message: "hi" });
    expect("isError" in told ? told.isError : false).toBe(true);
    expect(JSON.stringify(told)).toContain("not found");
    const aborted = await host.abortSession(scoped, humanOnly.title);
    expect(JSON.stringify(aborted)).toContain("not found");
    // Off Otium the same room is still listed idle and refused with the
    // precise reason, as before.
    const terminalCurrent = makeTopic({ surface: "terminal" });
    const terminalHuman = makeTopic({
      surface: "terminal",
      kind: "channel",
      agent: undefined,
      aiMode: "off",
    });
    expect(JSON.stringify(await host.peekSession(context(terminalCurrent)))).toContain(
      terminalHuman.title,
    );
    const refused = await host.tellSession(context(terminalCurrent), {
      to: terminalHuman.title,
      message: "hi",
    });
    expect(JSON.stringify(refused)).toContain("no AI agent");
  });

  test("on Otium remote (node/topic) sessions are fail-closed; off Otium the bridge still answers", async () => {
    const forwarded: PeerForwardArgs[] = [];
    let sessionsAsked = 0;
    const bridge: PeerSessionBridge = {
      async forward(args) {
        forwarded.push(args);
        return { ok: true };
      },
      async sessions() {
        sessionsAsked += 1;
        return {
          ok: true,
          nodes: [
            { node: "peer", sessions: [{ name: "remote-room", agent: "codex", hasSession: true }] },
          ],
        };
      },
      async reply() {
        return true;
      },
    };
    const unregister = registerPeerSessionBridge(bridge);
    try {
      const host = createDefaultSessionCommMcpHost();
      const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-peer-${randomUUID()}` });
      const scoped: SessionCommContext = {
        ...context(otiumRoom),
        actorUserId: "person",
        actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [otiumRoom.id] },
        peerHostQueryId: "hub-query",
      };
      // The bridge carries no actor and no assertion, so an Otium turn is not
      // shown remote rooms and cannot address them — with or without a hub
      // query id, and however complete its local assertion is.
      expect(JSON.stringify(await host.listSessions(scoped))).not.toContain("peer/remote-room");
      expect(sessionsAsked).toBe(0);
      for (const result of [
        await host.tellSession(scoped, { to: "peer/remote-room", message: "hi" }),
        await host.askSession(scoped, { to: "peer/remote-room", message: "?" }),
        await host.abortSession(scoped, "peer/remote-room"),
      ]) {
        expect("isError" in result ? result.isError : false).toBe(true);
        expect(JSON.stringify(result)).toContain("Otium room");
      }
      expect(forwarded).toEqual([]);
      // The refused ask left no pending marker behind.
      expect(
        listPendingAsksForCaller({ userId, from: `agent:${otiumRoom.title}` }).filter(
          (ask) => ask.to === "peer/remote-room",
        ),
      ).toEqual([]);

      // Terminal and Telegram rooms keep the existing peer behaviour: the
      // node's principal is the person, so the bridge is authoritative there.
      const terminalRoom = makeTopic({ surface: "terminal" });
      expect(JSON.stringify(await host.listSessions(context(terminalRoom)))).toContain(
        "peer/remote-room",
      );
      expect(sessionsAsked).toBe(1);
      const told = await host.tellSession(context(terminalRoom), {
        to: "peer/remote-room",
        message: "hi",
      });
      expect("isError" in told ? told.isError : false).not.toBe(true);
      expect(forwarded.map((args) => args.action)).toEqual(["tell"]);
      const aborted = await host.abortSession(context(terminalRoom), "peer/remote-room");
      expect("isError" in aborted ? aborted.isError : false).not.toBe(true);
      expect(forwarded.map((args) => args.action)).toEqual(["tell", "abort"]);
    } finally {
      unregister();
    }
  });

  test("with a hub grant an Otium turn reaches remote rooms through the hub, never the peer bridge", async () => {
    const forwarded: PeerForwardArgs[] = [];
    const unregister = registerPeerSessionBridge({
      async forward(args) {
        forwarded.push(args);
        return { ok: true };
      },
      async sessions() {
        return { ok: true, nodes: [{ node: "peer", sessions: [] }] };
      },
      async reply() {
        return true;
      },
    });
    const calls = stubHub((op) => {
      if (op === "sessions") {
        return Response.json({
          ok: true,
          v: 1,
          nodes: [
            {
              node: "gmovie",
              sessions: [
                { name: "Render", agent: "codex", status: "active", role: "member" },
                { name: "Humans", agent: null, status: "ready" },
              ],
            },
            { node: "offline", error: "node offline" },
          ],
        });
      }
      if (op === "peek") {
        return Response.json({
          ok: true,
          v: 1,
          nodes: [
            {
              node: "gmovie",
              sessions: [
                { name: "Render", status: "active" },
                { name: "Idle", status: "ready" },
              ],
            },
          ],
          pendingAsks: [{ to: "gmovie/Render", requestId: "r-1", status: "forwarded" }],
        });
      }
      if (op === "abort")
        return Response.json(
          { ok: false, error: 'Session "gmovie/Nope" not found.' },
          { status: 404 },
        );
      return Response.json({ ok: true, v: 1, replayed: false }, { status: 202 });
    });
    try {
      const host = createDefaultSessionCommMcpHost();
      const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
      const scoped: SessionCommContext = {
        ...context(otiumRoom),
        actorUserId: "person",
        actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [otiumRoom.id] },
        remoteSession: grant,
        currentThreadRootId: "thread-9",
      };
      // Listing: the hub's answer, addressed node/room, agentless rooms
      // omitted, an unreachable node named as such.
      const listed = JSON.stringify(await host.listSessions(scoped));
      expect(listed).toContain("gmovie/Render: active");
      expect(listed).not.toContain("Humans");
      expect(listed).toContain("offline/: (unreachable: node offline)");
      expect(calls.at(-1)).toMatchObject({
        op: "sessions",
        authorization: `Bearer ${grant.capability}`,
        body: { v: 1 },
      });
      // Peek: remote running/idle plus the hub-held asks.
      const peeked = JSON.stringify(await host.peekSession(scoped));
      expect(peeked).toContain("Remote running: gmovie/Render");
      expect(peeked).toContain("Remote idle: gmovie/Idle");
      expect(peeked).toContain("Pending gmovie/Render: forwarded (r-1)");
      // Tell: one call, no actor id in the body, depth already incremented.
      const told = await host.tellSession(scoped, { to: "gmovie/Render", message: "go" });
      expect("isError" in told ? told.isError : false).not.toBe(true);
      expect(JSON.stringify(told)).toContain("request_id");
      const tell = calls.at(-1)!;
      expect(tell.op).toBe("tell");
      expect(tell.body).toMatchObject({
        v: 1,
        to: { node: "gmovie", topic: "Render" },
        message: "go",
        depth: 1,
        fromLabel: { key: `agent:${otiumRoom.title}`, title: otiumRoom.title },
      });
      expect(typeof tell.body.requestId).toBe("string");
      expect(JSON.stringify(tell.body)).not.toContain("person");
      expect(JSON.stringify(tell.body)).not.toContain(userId);
      // Ask: the caller record is durable before the hub is called, and the
      // pending marker stays until the answer arrives.
      const asked = await host.askSession(scoped, { to: "gmovie/Render", message: "?" });
      expect("isError" in asked ? asked.isError : false).not.toBe(true);
      const ask = calls.at(-1)!;
      expect(ask.op).toBe("ask");
      expect(ask.body).toMatchObject({
        to: { node: "gmovie", topic: "Render" },
        message: "?",
        fromDepth: 0,
      });
      const requestId = String(ask.body.requestId);
      expect(getRemoteSessionAsk(requestId)).toMatchObject({
        callerTopicId: otiumRoom.id,
        userId,
        fromKey: `agent:${otiumRoom.title}`,
        toKey: "gmovie/Render",
        callerThreadRootId: "thread-9",
      });
      expect(
        listPendingAsksForCaller({ userId, from: `agent:${otiumRoom.title}` }).map((a) => a.to),
      ).toContain("gmovie/Render");
      // Abort: the hub's "not found" comes back as the tool error.
      const aborted = await host.abortSession(scoped, "gmovie/Nope");
      expect("isError" in aborted ? aborted.isError : false).toBe(true);
      expect(JSON.stringify(aborted)).toContain("not found");
      expect(calls.at(-1)!.op).toBe("abort");
      // The legacy bridge was never consulted.
      expect(forwarded).toEqual([]);
      // Off Otium the grant is irrelevant: the peer bridge answers as before.
      const terminalRoom = makeTopic({ surface: "terminal" });
      await host.tellSession(
        { ...context(terminalRoom), remoteSession: grant },
        { to: "peer/x", message: "hi" },
      );
      expect(forwarded.map((a) => a.action)).toEqual(["tell"]);
      expect(calls.filter((c) => c.op === "tell")).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  test("connection refused: local tools work, the remote list says so once, a provably undelivered ask leaves nothing pending", async () => {
    // A refused connection is the one transport failure that PROVES nothing
    // was delivered, so it is safe to settle as a clean failure and clean up.
    stubHub(() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    const host = createDefaultSessionCommMcpHost();
    const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
    const local = makeTopic({ surface: "otium", surfaceScope: otiumRoom.surfaceScope });
    const scoped: SessionCommContext = {
      ...context(otiumRoom),
      actorUserId: "person",
      actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id, local.id], ownedNodeTopicIds: [] },
      remoteSession: grant,
    };
    const listed = JSON.stringify(await host.listSessions(scoped));
    expect(listed).toContain(local.title);
    expect(listed.split("hub unreachable").length - 1).toBe(1);
    const told = await host.tellSession(scoped, { to: "gmovie/Render", message: "go" });
    expect("isError" in told ? told.isError : false).toBe(true);
    expect(JSON.stringify(told)).toContain("hub unreachable");
    const asked = await host.askSession(scoped, { to: "gmovie/Render", message: "?" });
    expect("isError" in asked ? asked.isError : false).toBe(true);
    expect(
      listPendingAsksForCaller({ userId, from: `agent:${otiumRoom.title}` }).filter(
        (a) => a.to === "gmovie/Render",
      ),
    ).toEqual([]);
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM remote_session_asks WHERE caller_topic_id = ?",
        )
        .get(otiumRoom.id)?.n,
    ).toBe(0);
    // A local tell still lands.
    const localTold = await host.tellSession(scoped, { to: local.title, message: "local" });
    expect("isError" in localTold ? localTold.isError : false).not.toBe(true);
  });

  test("a socket failure after the request went out is uncertain: the tell is unconfirmed and the ask stays pending", async () => {
    // The reason this is the default: `TypeError("fetch failed")` with no
    // socket cause is exactly what a hangup *after* the bytes left produces,
    // and it is indistinguishable from one before. Treating it as "never
    // delivered" deleted the durable ask, so the hub's late `ask-reply` 404'd
    // and the answer was lost; a `tell` retry duplicated the message instead.
    stubHub(() => {
      throw new TypeError("fetch failed");
    });
    const host = createDefaultSessionCommMcpHost();
    const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
    const scoped: SessionCommContext = {
      ...context(otiumRoom),
      actorUserId: "person",
      actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [] },
      remoteSession: grant,
    };
    const told = await host.tellSession(scoped, { to: "gmovie/Render", message: "go" });
    expect("isError" in told ? told.isError : false).not.toBe(true);
    expect(JSON.stringify(told)).toContain("delivery unconfirmed");
    const asked = await host.askSession(scoped, { to: "gmovie/Render", message: "?" });
    expect("isError" in asked ? asked.isError : false).not.toBe(true);
    expect(JSON.stringify(asked)).toContain("delivery unconfirmed");
    // Both markers survive, so a late answer from the hub still lands.
    expect(
      listPendingAsksForCaller({ userId, from: `agent:${otiumRoom.title}` }).map((a) => a.to),
    ).toContain("gmovie/Render");
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM remote_session_asks WHERE caller_topic_id = ?",
        )
        .get(otiumRoom.id)?.n,
    ).toBe(1);
  });

  test("a timeout after the request went out keeps the ask pending too", async () => {
    stubHub(() => {
      throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    });
    const host = createDefaultSessionCommMcpHost();
    const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
    const scoped: SessionCommContext = {
      ...context(otiumRoom),
      actorUserId: "person",
      actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [] },
      remoteSession: grant,
    };
    const asked = await host.askSession(scoped, { to: "gmovie/Render", message: "?" });
    expect("isError" in asked ? asked.isError : false).not.toBe(true);
    expect(JSON.stringify(asked)).toContain("delivery unconfirmed");
    expect(
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM remote_session_asks WHERE caller_topic_id = ?",
        )
        .get(otiumRoom.id)?.n,
    ).toBe(1);
  });

  test("a malformed 200 from the hub is a protocol failure, never a listing", async () => {
    // `[null]` used to pass the envelope check (it *is* an array) and then
    // crash the caller reading `session.name`.
    const bodies: unknown[] = [
      { ok: true, v: 1, nodes: [null] },
      { ok: true, v: 1, nodes: [{ node: "gmovie", sessions: [{ name: 42 }] }] },
      { ok: true, v: 1, nodes: [{ node: "gmovie/sub", sessions: [] }] },
      { ok: true, v: 1, nodes: [{ sessions: [] }] },
      // A node entry carries `sessions` or `error`, exactly one. Neither is a
      // node nobody can address or be told about; both would be printed as
      // unreachable *and* silently drop the rooms it did carry. Either way the
      // hub and this node disagree about what was said.
      { ok: true, v: 1, nodes: [{ node: "gmovie" }] },
      {
        ok: true,
        v: 1,
        nodes: [
          { node: "gmovie", sessions: [{ name: "Render", agent: "codex" }], error: "node offline" },
        ],
      },
      { ok: true, v: 1, nodes: [{ node: "gmovie", sessions: [], error: "node offline" }] },
      { ok: true, v: 1, nodes: [{ node: "gmovie", sessions: [], error: "" }] },
    ];
    for (const body of bodies) {
      stubHub(() => Response.json(body));
      const host = createDefaultSessionCommMcpHost();
      const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
      const scoped: SessionCommContext = {
        ...context(otiumRoom),
        actorUserId: "person",
        actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [] },
        remoteSession: grant,
      };
      const listed = JSON.stringify(await host.listSessions(scoped));
      expect(listed).toContain("unexpected body");
      expect(listed).not.toContain("gmovie/");
    }
  });

  test("a malformed 200 peek (bad pendingAsks) is a protocol failure too", async () => {
    stubHub((op) =>
      Response.json(
        op === "peek"
          ? { ok: true, v: 1, nodes: [], pendingAsks: [{ to: "a/b", requestId: "r", status: "x" }] }
          : { ok: true, v: 1, nodes: [] },
      ),
    );
    const host = createDefaultSessionCommMcpHost();
    const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
    const scoped: SessionCommContext = {
      ...context(otiumRoom),
      actorUserId: "person",
      actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [] },
      remoteSession: grant,
    };
    expect(JSON.stringify(await host.peekSession(scoped))).toContain("unexpected body");
  });

  test("a /peek room without a status is a protocol failure, not an idle room", async () => {
    // `/peek` exists to say which remote rooms are running, so `status` is the
    // whole answer there. Read as an absent optional field it fell into the
    // idle bucket — the node would report a busy room as idle on the strength
    // of a body that never said so. That is version skew, not a peek.
    stubHub((op) =>
      Response.json(
        op === "peek"
          ? {
              ok: true,
              v: 1,
              nodes: [{ node: "gmovie", sessions: [{ name: "Render" }] }],
              pendingAsks: [],
            }
          : { ok: true, v: 1, nodes: [] },
      ),
    );
    const host = createDefaultSessionCommMcpHost();
    const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
    const scoped: SessionCommContext = {
      ...context(otiumRoom),
      actorUserId: "person",
      actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [] },
      remoteSession: grant,
    };
    const peeked = JSON.stringify(await host.peekSession(scoped));
    expect(peeked).toContain("unexpected body");
    expect(peeked).not.toContain("gmovie/Render");
  });

  test("on /sessions a room without a status is still a listing", async () => {
    // The other half of the rule: `/sessions` describes rooms, where `status`
    // is an optional extra a v1 hub may omit. Requiring it there would make
    // every such listing a failure.
    stubHub(() =>
      Response.json({
        ok: true,
        v: 1,
        nodes: [{ node: "gmovie", sessions: [{ name: "Render", agent: "codex" }] }],
      }),
    );
    const host = createDefaultSessionCommMcpHost();
    const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
    const scoped: SessionCommContext = {
      ...context(otiumRoom),
      actorUserId: "person",
      actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [] },
      remoteSession: grant,
    };
    const listed = JSON.stringify(await host.listSessions(scoped));
    expect(listed).not.toContain("unexpected body");
    expect(listed).toContain("gmovie/Render");
  });

  test("the hub's in_progress code is retryable whatever status carries it", async () => {
    // The contract says 409, but a hub that flattens the target node's 409
    // into its own 502 while keeping the code is still saying "in flight".
    for (const status of [409, 502]) {
      let attempts = 0;
      stubHub(() => {
        attempts += 1;
        return Response.json(
          { ok: false, v: 1, error: "still working", code: "in_progress" },
          {
            status,
          },
        );
      });
      const host = createDefaultSessionCommMcpHost();
      const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
      const scoped: SessionCommContext = {
        ...context(otiumRoom),
        actorUserId: "person",
        actorTopicScope: { visibleNodeTopicIds: [otiumRoom.id], ownedNodeTopicIds: [] },
        remoteSession: grant,
      };
      const told = await host.tellSession(scoped, { to: "gmovie/Render", message: "go" });
      // Retried (3 attempts), then reported as unconfirmed rather than failed.
      expect(attempts).toBe(3);
      expect("isError" in told ? told.isError : false).not.toBe(true);
      expect(JSON.stringify(told)).toContain("delivery unconfirmed");
    }
  });

  test("an expired grant (hub 401) is a clear error, not a fallback to the peer bridge", async () => {
    const forwarded: PeerForwardArgs[] = [];
    const unregister = registerPeerSessionBridge({
      async forward(args) {
        forwarded.push(args);
        return { ok: true };
      },
      async sessions() {
        return { ok: true, nodes: [] };
      },
      async reply() {
        return true;
      },
    });
    stubHub(() => Response.json({ ok: false, error: "capability revoked" }, { status: 401 }));
    try {
      const host = createDefaultSessionCommMcpHost();
      const otiumRoom = makeTopic({ surface: "otium", surfaceScope: `ws-hub-${randomUUID()}` });
      const scoped: SessionCommContext = {
        ...context(otiumRoom),
        actorUserId: "person",
        remoteSession: grant,
      };
      const told = await host.tellSession(scoped, { to: "gmovie/Render", message: "go" });
      expect("isError" in told ? told.isError : false).toBe(true);
      expect(JSON.stringify(told)).toContain("no longer valid");
      expect(forwarded).toEqual([]);
    } finally {
      unregister();
    }
  });

  test("clears pending asks when the target has no agent", async () => {
    const source = makeTopic();
    const target = makeTopic({ kind: "channel", agent: undefined, aiMode: "off" });
    const host = createDefaultSessionCommMcpHost();
    const current = context(source);

    const first = await host.askSession(current, { to: target.title, message: "question one" });
    const second = await host.askSession(current, { to: target.title, message: "question two" });

    expect("isError" in first ? first.isError : false).toBe(true);
    expect("isError" in second ? second.isError : false).toBe(true);
    expect(second.content[0]?.text).not.toContain("already pending");
    expect(listPendingAsksForCaller({ userId, from: `agent:${source.title}` })).toEqual([]);
  });
});
