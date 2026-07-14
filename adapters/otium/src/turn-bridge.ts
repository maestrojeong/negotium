/**
 * Worker-side peer turn execution. Each hub room maps to one hidden local
 * mirror topic (otium_peer_sessions) that reuses negotium's normal turn
 * pipeline — session resume, MCP catalog, project cwd, abort/preempt.
 *
 * Port of otium's `apps/runtime-api/src/peer/turn-runner.ts` on top of the
 * `@negotium/core` barrel:
 *  - executionSpec has no direct `triggerTopicAiTurn` parameter, so the
 *    hub-resolved model/effort/mcp are pinned via
 *    `setApiTopicConfig` right before the turn — config override wins over
 *    topic defaults in `startAiTurn`, which makes the hub spec authoritative.
 *  - agent/model changes invalidate the stored provider session
 *    (`peer-execution-spec-changed`), matching otium.
 *  - hub-resolved config is pinned on the mirror topic,
 *    while `peerBridge` carries canonical-room mutations such as
 *    spawn_subagent back to Otium.
 */

import { randomUUID } from "node:crypto";
import {
  type AgentKind,
  abortRoom,
  clearTopicSessionId,
  type EffortLevel,
  getApiTopicConfig,
  getRoomQuery,
  getTopic,
  isAgentKind,
  isTopicShared,
  isTopicVisible,
  logger,
  setApiTopicConfig,
  triggerTopicAiTurn,
  upsertTopic,
} from "@negotium/core";
import type { PeerNode } from "@/central";
import {
  createTurnForwarder,
  getActiveForwarder,
  hubEventSender,
  registerTurnForwarder,
  type SendPeerEvent,
} from "@/event-backflow";
import type { PeerProvisionRequest, PeerTurnRequest, PlacedTopicExecutionSpec } from "@/protocol";
import {
  claimPeerTurnRequest,
  createPeerSession,
  getPeerSession,
  getPeerTurnRequest,
  markPeerTurnRequestFailed,
  markPeerTurnRequestRunning,
} from "@/store";

const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

function executionFor(payload: PeerTurnRequest): PlacedTopicExecutionSpec | null {
  if (payload.execution) return payload.execution;
  if (!payload.agent) return null;
  return {
    agent: payload.agent,
    model: payload.model ?? "",
    effort: payload.effort ?? "medium",
    mcp: [],
    canSpawnSubagents: false,
  };
}

export type ProvisionResult =
  | { ok: true; localTopicId: string; bindingMode: "mirror" | "shared" }
  | { ok: false; error: string; status: number };

/**
 * Idempotent hidden-mirror upsert keyed on (hostCellId, hostTopicId). The
 * mirror has explicit `visibility: hidden`. `isSubagent` remains separate
 * execution metadata (MCP whitelist not inherited); `canSpawnSubagents` is
 * carried separately in the per-turn peerBridge context.
 */
export function provisionMirrorTopic(
  hostCellId: string,
  payload: Omit<PeerProvisionRequest, "v">,
): ProvisionResult {
  const execution = payload.execution;
  if (!isAgentKind(execution.agent)) {
    return { ok: false, error: `unknown agent "${execution.agent}"`, status: 400 };
  }
  const existing = getPeerSession(hostCellId, payload.hostTopicId);
  if (existing?.binding_mode === "shared") {
    const shared = getTopic(existing.local_topic_id);
    if (!shared) {
      return { ok: false, error: "bound local topic no longer exists", status: 404 };
    }
    if (!isTopicVisible(shared)) {
      return { ok: false, error: "bound local topic is hidden", status: 409 };
    }
    if (!isTopicShared(shared)) {
      return { ok: false, error: "bound local topic is private", status: 409 };
    }
    if (!shared.participants.some((participant) => participant.userId === payload.userId)) {
      return { ok: false, error: "bound local topic is not visible to this user", status: 403 };
    }
    return { ok: true, localTopicId: shared.id, bindingMode: "shared" };
  }
  const localTopicId = existing?.local_topic_id ?? `peer-${randomUUID()}`;
  const now = new Date().toISOString();
  const current = existing ? getTopic(localTopicId) : null;
  const currentConfig = current ? getApiTopicConfig(localTopicId) : undefined;
  const currentModel = currentConfig?.model ?? current?.defaultModel ?? "";
  const nextModel = execution.model || current?.defaultModel || "";
  const providerSessionIsStale =
    Boolean(current) && (current?.agent !== execution.agent || currentModel !== nextModel);
  upsertTopic({
    id: localTopicId,
    title: payload.topicTitle,
    kind: "agent",
    agent: execution.agent as AgentKind,
    aiMode: "always",
    defaultModel: nextModel,
    defaultEffort: EFFORT_LEVELS.includes(execution.effort)
      ? (execution.effort as EffortLevel)
      : (current?.defaultEffort ?? "medium"),
    participants: [{ userId: payload.userId, role: "owner" }],
    isSubagent: true,
    visibility: "hidden",
    accessMode: "shared",
    ...(execution.description ? { description: execution.description } : {}),
    createdAt: current?.createdAt ?? now,
    lastMessageAt: now,
  });
  // Pin the hub-resolved execution spec as the topic's
  // config override so startAiTurn resolves exactly the hub's values.
  setApiTopicConfig(localTopicId, {
    ...(execution.model ? { model: execution.model } : {}),
    ...(EFFORT_LEVELS.includes(execution.effort)
      ? { effort: execution.effort as EffortLevel }
      : {}),
    mcp: execution.mcp,
  });
  if (providerSessionIsStale) {
    clearTopicSessionId(localTopicId, "peer-execution-spec-changed");
  }
  if (!existing) createPeerSession(hostCellId, payload.hostTopicId, localTopicId);
  return { ok: true, localTopicId, bindingMode: "mirror" };
}

export type RunPeerTurnResult = { ok: true } | { ok: false; error: string; status: number };

type TurnTrigger = typeof triggerTopicAiTurn;

let turnTrigger: TurnTrigger = triggerTopicAiTurn;

/** Test seam — replace the turn dispatcher so tests never start a real
 *  provider turn (and never spend agent API tokens). */
export function __setTurnTriggerForTests(trigger: TurnTrigger | null): void {
  turnTrigger = trigger ?? triggerTopicAiTurn;
}

/**
 * Resolve (or create) the hidden execution topic for a hub room and run one
 * turn on it. Accepting is synchronous ({ok:true} means "claimed and
 * started"); every result flows back through `/api/v1/peer/event`.
 */
export function runPeerTurn(
  hubNode: PeerNode,
  hostCellId: string,
  payload: PeerTurnRequest,
  opts: { sendEvent?: SendPeerEvent } = {},
): RunPeerTurnResult {
  const execution = executionFor(payload);
  if (!execution || !isAgentKind(execution.agent)) {
    return { ok: false, error: `unknown agent "${execution?.agent ?? ""}"`, status: 400 };
  }

  // Durable exactly-once claim (at-least-once senders): a replay of a
  // non-failed request acks without re-execution; the same requestId bound to
  // another room is a hard conflict.
  const claim = claimPeerTurnRequest(hostCellId, payload.requestId, payload.hostTopicId);
  if (!claim.claimed) {
    if (claim.row.host_topic_id !== payload.hostTopicId) {
      return { ok: false, error: "requestId already belongs to another room", status: 409 };
    }
    if (claim.row.status === "failed") {
      return { ok: false, error: claim.row.error ?? "previous attempt failed", status: 409 };
    }
    logger.info(
      { requestId: payload.requestId, hostTopicId: payload.hostTopicId, status: claim.row.status },
      "otium: peer turn replay acknowledged without re-execution",
    );
    return { ok: true };
  }

  const provisioned = provisionMirrorTopic(hostCellId, {
    userId: payload.userId,
    hostTopicId: payload.hostTopicId,
    topicTitle: payload.topicTitle,
    execution,
  });
  if (!provisioned.ok) {
    markPeerTurnRequestFailed(hostCellId, payload.requestId, provisioned.error);
    return provisioned;
  }
  const localTopicId = provisioned.localTopicId;
  const localTopic = getTopic(localTopicId);
  const turnAgent =
    provisioned.bindingMode === "shared" && localTopic?.agent
      ? localTopic.agent
      : (execution.agent as AgentKind);

  // A new turn for a room whose previous turn is still streaming supersedes
  // it (user preemption). Settle the old forwarder so the hub's old
  // peer_turn reaches a terminal state instead of dangling until the
  // watchdog.
  const previous = getActiveForwarder(localTopicId);
  if (previous) {
    previous.finish({
      type: "ai_aborted",
      queryId: previous.queryId ?? previous.requestId,
      topicId: localTopicId,
      reason: "superseded",
    });
  }

  const forwarder = createTurnForwarder({
    hostNodeId: hostCellId,
    requestId: payload.requestId,
    localTopicId,
    sendEvent: opts.sendEvent ?? hubEventSender(hubNode),
  });
  registerTurnForwarder(localTopicId, forwarder);

  let queryId: string | null = null;
  try {
    queryId = turnTrigger(localTopicId, payload.userId, payload.message, turnAgent, {
      // "user" origin: a fresh hub message preempts a running turn, exactly
      // like a local room.
      origin: "user",
      requestId: payload.requestId,
      injectAuthorId: payload.userId,
      attachments: payload.attachments,
      // Provider session recovery dispatches a fresh queryId. Keep the
      // forwarder on that retry so its messages and terminal are not filtered
      // as stale events from the superseded provider attempt.
      onDispatched: (dispatchedQueryId) => {
        forwarder.queryId = dispatchedQueryId;
      },
      peerBridge: {
        hubCellId: hostCellId,
        hostTopicId: payload.hostTopicId,
        hostQueryId: payload.requestId,
        canSpawnSubagents: execution.canSpawnSubagents,
      },
    });
  } catch (err) {
    forwarder.finish({
      type: "ai_error",
      queryId: payload.requestId,
      topicId: localTopicId,
      error: `worker dispatch crashed: ${(err as Error).message}`,
    });
    markPeerTurnRequestFailed(hostCellId, payload.requestId, "failed to start turn");
    return { ok: false, error: "failed to start turn", status: 500 };
  }
  if (!queryId) {
    forwarder.finish({
      type: "ai_error",
      queryId: payload.requestId,
      topicId: localTopicId,
      error: "worker could not start the turn",
    });
    markPeerTurnRequestFailed(hostCellId, payload.requestId, "failed to start turn");
    return { ok: false, error: "failed to start turn", status: 500 };
  }
  // Test seams and older dispatchers may return an id without invoking the
  // hook; the returned initial id remains the fallback.
  forwarder.queryId = queryId;
  markPeerTurnRequestRunning(hostCellId, payload.requestId);
  logger.info(
    { requestId: payload.requestId, localTopicId, queryId, title: payload.topicTitle },
    "otium: peer turn running",
  );
  return { ok: true };
}

/**
 * Abort one exact hub request — only when that request is still the room's
 * active turn, so a stale abort cannot terminate a successor turn that
 * started while it was in flight. The worker's `ai_aborted` event (emitted by
 * the dying turn through the bus) is the authoritative terminal.
 */
export function abortHostedPeerTurn(
  hostNodeId: string,
  requestId: string,
  userId: string,
  topicTitle: string,
): boolean {
  const request = getPeerTurnRequest(hostNodeId, requestId);
  if (!request || request.status !== "running") return false;
  const session = getPeerSession(hostNodeId, request.host_topic_id);
  if (!session) return false;
  const topic = getTopic(session.local_topic_id);
  if (
    !topic ||
    topic.title !== topicTitle ||
    !topic.participants.some((participant) => participant.userId === userId)
  ) {
    return false;
  }
  const forwarder = getActiveForwarder(session.local_topic_id);
  if (!forwarder || forwarder.requestId !== requestId) return false;
  if (!getRoomQuery(session.local_topic_id)) return false;
  return abortRoom(session.local_topic_id);
}
