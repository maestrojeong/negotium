import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getApiTopicConfig, getTopic, getTopicSessionId, setTopicSessionId } from "@negotium/core";
import { configureOtiumCentral, type PeerNode } from "@/central";
import { getActiveForwarder, type SendPeerEvent } from "@/event-backflow";
import { storePeerInputFile } from "@/peer-files";
import { PEER_PROTOCOL_VERSION, type PlacedTopicExecutionSpec } from "@/protocol";
import { getPeerSession, getPeerTurnRequest } from "@/store";
import { __setTurnTriggerForTests, provisionMirrorTopic, runPeerTurn } from "@/turn-bridge";
import { type FakeCentral, HUB_CELL_ID, startFakeCentral, waitFor } from "./helpers";

const USER = "central-user-1";

let central: FakeCentral;

beforeAll(() => {
  central = startFakeCentral();
  configureOtiumCentral(central.join);
});

afterAll(() => {
  configureOtiumCentral(null);
  central.stop();
});

afterEach(() => {
  __setTurnTriggerForTests(null);
});

function execution(overrides: Partial<PlacedTopicExecutionSpec> = {}): PlacedTopicExecutionSpec {
  return {
    agent: "claude",
    model: "sonnet",
    effort: "high",
    mcp: ["playwright"],
    canSpawnSubagents: true,
    ...overrides,
  };
}

function hubNode(): PeerNode {
  return {
    cellId: HUB_CELL_ID,
    nodeName: null,
    isPrimary: true,
    baseUrl: central.hubBaseUrl,
    self: false,
  };
}

/** Collects hub-bound events without any HTTP round trip. */
function recordingSender(): { sent: Array<{ seq: number; event: Record<string, unknown> }> } & {
  send: SendPeerEvent;
} {
  const sent: Array<{ seq: number; event: Record<string, unknown> }> = [];
  return {
    sent,
    send: async ({ seq, event }) => {
      sent.push({ seq, event });
      return { ok: true };
    },
  };
}

describe("provisionMirrorTopic", () => {
  test("creates a hidden mirror topic with the hub execution spec pinned as config", () => {
    const result = provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-topic-1",
      topicTitle: "프로젝트방",
      execution: execution({ description: "hub room" }),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.localTopicId.startsWith("peer-")).toBe(true);

    const topic = getTopic(result.localTopicId);
    expect(topic?.title).toBe("프로젝트방");
    expect(topic?.kind).toBe("agent");
    expect(topic?.agent).toBe("claude");
    expect(topic?.isSubagent).toBe(true);
    expect(topic?.visibility).toBe("hidden");
    expect(topic?.accessMode).toBe("shared");
    expect(topic?.participants).toEqual([{ userId: USER, role: "owner" }]);

    const config = getApiTopicConfig(result.localTopicId);
    expect(config?.model).toBe("sonnet");
    expect(config?.effort).toBe("high");
    expect(config?.mcp).toEqual(["playwright"]);

    const session = getPeerSession(HUB_CELL_ID, "host-topic-1");
    expect(session?.local_topic_id).toBe(result.localTopicId);
  });

  test("is idempotent on (hostCellId, hostTopicId) and follows title changes", () => {
    const first = provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-topic-2",
      topicTitle: "이름 A",
      execution: execution(),
    });
    const second = provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-topic-2",
      topicTitle: "이름 B",
      execution: execution(),
    });
    if (!first.ok || !second.ok) throw new Error("provision failed");
    expect(second.localTopicId).toBe(first.localTopicId);
    expect(getTopic(first.localTopicId)?.title).toBe("이름 B");
  });

  test("invalidates the provider session when agent or model changes", () => {
    const provisioned = provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-topic-3",
      topicTitle: "세션방",
      execution: execution({ agent: "claude", model: "sonnet" }),
    });
    if (!provisioned.ok) throw new Error(provisioned.error);
    const localTopicId = provisioned.localTopicId;
    setTopicSessionId(localTopicId, "provider-session-1");

    // Same spec → session survives re-provision (every turn re-provisions).
    provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-topic-3",
      topicTitle: "세션방",
      execution: execution({ agent: "claude", model: "sonnet" }),
    });
    expect(getTopicSessionId(localTopicId)).toBe("provider-session-1");

    // Model change → stale session cleared (peer-execution-spec-changed).
    provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-topic-3",
      topicTitle: "세션방",
      execution: execution({ agent: "claude", model: "opus" }),
    });
    expect(getTopicSessionId(localTopicId)).toBeNull();
  });

  test("rejects unknown agents with the contract error", () => {
    const result = provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-topic-4",
      topicTitle: "x",
      execution: execution({ agent: "gpt-99" }),
    });
    expect(result).toEqual({ ok: false, error: 'unknown agent "gpt-99"', status: 400 });
  });
});

describe("runPeerTurn", () => {
  test("rejects an attachment uploaded for another peer topic", async () => {
    const source = provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId: "host-attachment-source",
      topicTitle: "source",
      execution: execution(),
    });
    if (!source.ok) throw new Error(source.error);
    const attachment = await storePeerInputFile(
      new File(["private bytes"], "private.txt", { type: "text/plain" }),
      { topicId: source.localTopicId, ownerUserId: USER },
    );
    __setTurnTriggerForTests(() => "must-not-dispatch");

    const result = runPeerTurn(
      hubNode(),
      HUB_CELL_ID,
      {
        v: PEER_PROTOCOL_VERSION,
        requestId: `pt-cross-topic-file-${crypto.randomUUID()}`,
        userId: USER,
        hostTopicId: "host-attachment-target",
        topicTitle: "target",
        execution: execution(),
        message: "read it",
        attachments: [attachment.id],
      },
      { sendEvent: recordingSender().send },
    );

    expect(result).toEqual({ ok: false, error: "attachment access denied", status: 403 });
  });

  test("accepts an attachment owned by the same peer topic and user", async () => {
    const hostTopicId = `host-owned-file-${crypto.randomUUID()}`;
    const target = provisionMirrorTopic(HUB_CELL_ID, {
      userId: USER,
      hostTopicId,
      topicTitle: "target",
      execution: execution(),
    });
    if (!target.ok) throw new Error(target.error);
    const attachment = await storePeerInputFile(
      new File(["allowed bytes"], "allowed.txt", { type: "text/plain" }),
      { topicId: target.localTopicId, ownerUserId: USER },
    );
    let receivedAttachments: string[] | undefined;
    __setTurnTriggerForTests((_topicId, _userId, _prompt, _agent, opts) => {
      receivedAttachments = opts?.attachments;
      return "owned-file-query";
    });

    const result = runPeerTurn(
      hubNode(),
      HUB_CELL_ID,
      {
        v: PEER_PROTOCOL_VERSION,
        requestId: `pt-owned-file-${crypto.randomUUID()}`,
        userId: USER,
        hostTopicId,
        topicTitle: "target",
        execution: execution(),
        message: "read it",
        attachments: [attachment.id],
      },
      { sendEvent: recordingSender().send },
    );

    expect(result).toEqual({ ok: true });
    expect(receivedAttachments).toEqual([attachment.id]);
  });

  test("claims the requestId once and wires triggerTopicAiTurn with hub semantics", async () => {
    const calls: Array<{
      topicId: string;
      userId: string;
      prompt: string;
      agent: string | undefined;
      opts: Record<string, unknown> | undefined;
    }> = [];
    __setTurnTriggerForTests((topicId, userId, prompt, agent, opts) => {
      calls.push({ topicId, userId, prompt, agent, opts: opts as Record<string, unknown> });
      return "query-1";
    });
    const recorder = recordingSender();

    const payload = {
      v: PEER_PROTOCOL_VERSION,
      requestId: "pt-turn-1",
      userId: USER,
      hostTopicId: "host-turn-1",
      topicTitle: "터닝방",
      execution: execution(),
      message: "안녕",
    };
    const result = runPeerTurn(hubNode(), HUB_CELL_ID, payload, { sendEvent: recorder.send });
    expect(result).toEqual({ ok: true });

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    const session = getPeerSession(HUB_CELL_ID, "host-turn-1");
    expect(call.topicId).toBe(session?.local_topic_id ?? "");
    expect(call.userId).toBe(USER);
    expect(call.prompt).toBe("안녕");
    expect(call.agent).toBe("claude");
    expect(call.opts?.origin).toBe("user");
    expect(call.opts?.requestId).toBe("pt-turn-1");
    expect(call.opts?.injectAuthorId).toBe(USER);
    expect(call.opts?.peerBridge).toEqual({
      hubCellId: HUB_CELL_ID,
      hostTopicId: "host-turn-1",
      hostQueryId: "pt-turn-1",
      canSpawnSubagents: true,
    });

    expect(getPeerTurnRequest(HUB_CELL_ID, "pt-turn-1")?.status).toBe("running");

    // At-least-once sender: the replay acks without re-execution.
    const replay = runPeerTurn(hubNode(), HUB_CELL_ID, payload, { sendEvent: recorder.send });
    expect(replay).toEqual({ ok: true });
    expect(calls.length).toBe(1);

    // The same requestId for another room is a hard conflict.
    const conflict = runPeerTurn(
      hubNode(),
      HUB_CELL_ID,
      { ...payload, hostTopicId: "host-turn-other" },
      { sendEvent: recorder.send },
    );
    expect(conflict).toEqual({
      ok: false,
      error: "requestId already belongs to another room",
      status: 409,
    });
  });

  test("a failed dispatch emits an ai_error terminal and 409s the replay", async () => {
    __setTurnTriggerForTests(() => null);
    const recorder = recordingSender();
    const payload = {
      v: PEER_PROTOCOL_VERSION,
      requestId: "pt-turn-2",
      userId: USER,
      hostTopicId: "host-turn-2",
      topicTitle: "실패방",
      execution: execution(),
      message: "hi",
    };
    const result = runPeerTurn(hubNode(), HUB_CELL_ID, payload, { sendEvent: recorder.send });
    expect(result).toEqual({ ok: false, error: "failed to start turn", status: 500 });
    await waitFor(() => recorder.sent.length === 1);
    expect(recorder.sent[0]!.seq).toBe(1);
    expect(recorder.sent[0]!.event.type).toBe("ai_error");
    expect(recorder.sent[0]!.event.queryId).toBe("pt-turn-2");

    expect(getPeerTurnRequest(HUB_CELL_ID, "pt-turn-2")?.status).toBe("failed");
    const replay = runPeerTurn(hubNode(), HUB_CELL_ID, payload, { sendEvent: recorder.send });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.status).toBe(409);
  });

  test("tracks a fresh queryId when provider session recovery redispatches the turn", () => {
    let onDispatched: ((queryId: string) => void) | undefined;
    __setTurnTriggerForTests((_topicId, _userId, _prompt, _agent, opts) => {
      onDispatched = opts?.onDispatched;
      onDispatched?.("query-initial");
      return "query-initial";
    });
    const recorder = recordingSender();
    const result = runPeerTurn(
      hubNode(),
      HUB_CELL_ID,
      {
        v: PEER_PROTOCOL_VERSION,
        requestId: "pt-turn-recovery",
        userId: USER,
        hostTopicId: "host-turn-recovery",
        topicTitle: "복구방",
        execution: execution(),
        message: "resume",
      },
      { sendEvent: recorder.send },
    );
    expect(result).toEqual({ ok: true });

    const session = getPeerSession(HUB_CELL_ID, "host-turn-recovery");
    const forwarder = session ? getActiveForwarder(session.local_topic_id) : undefined;
    expect(forwarder?.queryId).toBe("query-initial");
    onDispatched?.("query-retry");
    expect(forwarder?.queryId).toBe("query-retry");
    forwarder?.finish({
      type: "ai_aborted",
      queryId: "query-retry",
      topicId: session?.local_topic_id,
      reason: "test cleanup",
    });
  });

  test("a new turn supersedes the previous one with a synthetic ai_aborted terminal", async () => {
    __setTurnTriggerForTests(() => `query-${Math.random().toString(36).slice(2)}`);
    const first = recordingSender();
    const second = recordingSender();
    const base = {
      v: PEER_PROTOCOL_VERSION,
      userId: USER,
      hostTopicId: "host-turn-3",
      topicTitle: "선점방",
      execution: execution(),
      message: "turn",
    };
    expect(
      runPeerTurn(
        hubNode(),
        HUB_CELL_ID,
        { ...base, requestId: "pt-turn-3a" },
        { sendEvent: first.send },
      ),
    ).toEqual({ ok: true });
    expect(
      runPeerTurn(
        hubNode(),
        HUB_CELL_ID,
        { ...base, requestId: "pt-turn-3b" },
        { sendEvent: second.send },
      ),
    ).toEqual({ ok: true });

    await waitFor(() => first.sent.length === 1);
    expect(first.sent[0]!.event).toMatchObject({ type: "ai_aborted", reason: "superseded" });
    expect(second.sent.length).toBe(0);
    expect(getPeerTurnRequest(HUB_CELL_ID, "pt-turn-3a")?.status).toBe("finished");
    expect(getPeerTurnRequest(HUB_CELL_ID, "pt-turn-3b")?.status).toBe("running");
  });
});
