/**
 * Turn runner — executes one AI turn for a topic and streams its events.
 *
 * Port of otium's `api/routes/ai.ts` with the REST route table removed and the
 * WsHub replaced by the channel-agnostic RuntimeBus (`#bus`). Agent execution
 * remains local, while an optional peerBridge routes canonical room mutations
 * back through the placement adapter.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupAgentFork, type ForkHandle } from "#agents/fork";
import { runAgent } from "#agents/index";
import { settleSubagentFailure } from "#agents/mcp-tools/spawn-subagent";
import { getRegistry } from "#agents/registry";
import { WsHub } from "#bus";
import { ensureBgBash } from "#platform/background-bash/manager";
import { FROM_AUTO_CONTINUE } from "#platform/constants";
import { logger } from "#platform/logger";
import { consumePlaywrightUnavailable, markPlaywrightUnavailable } from "#platform/mcp-config";
import {
  ensurePlaywright,
  getPlaywrightCapability,
  makeInstanceKey,
  pinPlaywrightInstance,
  unpinPlaywrightInstance,
} from "#platform/playwright/manager";
import {
  buildChannelSystemPrompt,
  buildManagerSystemPrompt,
  buildMemoryPromptSection,
  buildTopicSystemPrompt,
} from "#prompts/builders";
import {
  type DeferredInject,
  DeferredInjectBatcher,
  decideNewQuery,
  deferInject,
  getRoomQuery,
  interSessionQueue,
  isolatedTurnRoomId,
  isUserOrigin,
  type RoomQueryControl,
  setRoomQuery,
  takeDeferredInject,
} from "#query/active-rooms";
import { writeQueryState } from "#query/state";
import { AbortReason } from "#query/types";
import {
  materializePromptAttachments,
  promptWithAttachments,
  workspaceCwdFor,
} from "#runtime/attachments";
import { buildMentionOnlyChannelPrompt } from "#runtime/channel-context";
import { classifyAgentError, stringifyError } from "#runtime/errors";
import { withTurnSilenceHeartbeat } from "#runtime/event-heartbeat";
import { getTopicConfig } from "#runtime/topic-config";
import { runTurnEventStream, type StreamAgentOutcome } from "#runtime/turn-event-stream";
import {
  type AiTurnTopic,
  resolveTopicTurnExecution,
  resolveTopicTurnSession,
} from "#runtime/turn-session";
import { getActiveVisualForPrompt } from "#runtime/visual-store";
import { activeVisualHtmlForPrompt } from "#runtime/visuals";
import { appendApiMessage } from "#storage/api-messages";
import { resolveTopicBrief } from "#storage/api-topic-brief";
import {
  clearTopicSessionId,
  getTopic,
  getTopicMemoryOrigin,
  getTopicSessionId,
} from "#storage/api-topics";
import { getGlobalAiName } from "#storage/app-settings";
import { isTopicBrowserProfileOwner } from "#storage/browser-profiles";
import { appendConversationEvent, readConversation } from "#storage/conversations";
import {
  getRuntimeTurnLease,
  RUNTIME_INSTANCE_ID,
  requestRuntimeTurnAbort,
} from "#storage/runtime-leases";
import { getRuntimeTopicEpoch, isRuntimeTopicMaintenance } from "#storage/runtime-topic-state";
import {
  claimNextRuntimeUserTurnRequest,
  completeRuntimeUserTurnRequest,
  enqueueRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
  markRuntimeUserTurnRunning,
  type RuntimeUserTurnExecution,
  releaseRuntimeUserTurnClaim,
} from "#storage/runtime-turn-requests";
import type { PendingAskUserId } from "#storage/session-asks";
import { getSharedWikiDir } from "#storage/wiki";
import {
  isTopicBriefFile,
  isTopicSummaryFile,
  wikiBriefStorageKey,
  wikiSummaryFilename,
} from "#storage/wiki-summary-names";
import { getTopics } from "#topics/derive";
import type { AgentKind, EffortLevel, PeerRuntimeBridgeContext, UnifiedEvent } from "#types";
import type { MessageDto, TopicDto } from "#types/api";

// 분해된 헬퍼 모듈 재노출 — 기존 @/api/routes/ai 소비자(테스트 포함) 경로 유지
export * from "#agents/model-catalog";
export * from "#runtime/attachments";
export * from "#runtime/channel-context";
export * from "#runtime/errors";
export * from "#runtime/tasks";
export * from "#runtime/turn-session";
export * from "#runtime/visuals";

// In-flight AI turns are tracked room-keyed (topicId → control) in
// #query/active-rooms so a new user message on a room can supersede the
// running turn (Otium abort-on-new-message). See startAiTurn / abortRoom.
const PLAYWRIGHT_UNAVAILABLE_NOTICE_COOLDOWN_MS = 5 * 60_000;
const ASK_REPLY_INJECT_BATCH_MS = 500;
const playwrightUnavailableNoticeAt = new Map<string, number>();

/** Browser and background shell tools are part of every ordinary topic. */
export function withDefaultPlaywright(configuredMcp: string[], isManager: boolean): string[] {
  if (isManager) return configuredMcp;
  const enabled = new Set(configuredMcp);
  enabled.add("playwright");
  enabled.add("background-bash");
  return [...enabled];
}

// dequeueAll() is the merge primitive; this short gate makes the first reply
// to an idle caller wait long enough for sibling ask replies to join it.
const askReplyInjectBatcher = new DeferredInjectBatcher({
  queue: interSessionQueue,
  delayMs: ASK_REPLY_INJECT_BATCH_MS,
  isBusy: (topicId) => Boolean(getRoomQuery(topicId)),
  dispatch: (inject) => redispatchInject(inject),
});

function appendSystemMessage(topicId: string, text: string): MessageDto {
  const message: MessageDto = {
    id: randomUUID(),
    topicId,
    authorId: "system",
    text,
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(message, { notify: false });
  WsHub.get().broadcastMessage(topicId, message);
  return message;
}

function notifyPlaywrightUnavailable(topicId: string) {
  const now = Date.now();
  const last = playwrightUnavailableNoticeAt.get(topicId) ?? 0;
  if (now - last < PLAYWRIGHT_UNAVAILABLE_NOTICE_COOLDOWN_MS) return;
  playwrightUnavailableNoticeAt.set(topicId, now);
  appendSystemMessage(
    topicId,
    "Playwright browser tools are unavailable this turn. Browser automation was removed from the tool catalog; retry shortly if browser interaction is required.",
  );
}

function appendAskReplyMessage(
  topicId: string,
  text: string,
  agentType?: AgentKind | null,
): MessageDto {
  const message: MessageDto = {
    id: randomUUID(),
    topicId,
    authorId: "ai",
    text,
    ...(agentType ? { agentType } : {}),
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(message, { notify: false });
  WsHub.get().broadcastMessage(topicId, message);
  return message;
}

function resolveWikiMirrorPath(
  directory: string,
  preferredFilename: string,
  matchesStableId: (filename: string) => boolean,
  matchesLegacyTitle: (filename: string) => boolean,
): string {
  const preferred = join(directory, preferredFilename);
  if (existsSync(preferred)) return preferred;

  let newestStableId: { path: string; mtimeMs: number } | null = null;
  let newestLegacyTitle: { path: string; mtimeMs: number } | null = null;
  try {
    for (const filename of readdirSync(directory)) {
      const stableIdMatch = matchesStableId(filename);
      if (!stableIdMatch && !matchesLegacyTitle(filename)) continue;
      const path = join(directory, filename);
      const mtimeMs = statSync(path).mtimeMs;
      if (stableIdMatch) {
        if (!newestStableId || mtimeMs > newestStableId.mtimeMs) {
          newestStableId = { path, mtimeMs };
        }
      } else if (!newestLegacyTitle || mtimeMs > newestLegacyTitle.mtimeMs) {
        newestLegacyTitle = { path, mtimeMs };
      }
    }
  } catch {
    // The mirror is best-effort; callers can still use the SQLite brief.
  }
  return newestStableId?.path ?? newestLegacyTitle?.path ?? preferred;
}

export async function streamAgentEvents(
  topicId: string,
  topicTitle: string,
  queryId: string,
  events: AsyncGenerator<UnifiedEvent>,
  control: RoomQueryControl,
  agentType: AgentKind,
  model: string,
  effort: EffortLevel | undefined,
  userId: string,
  retryableSessionExpired = true,
  onSessionId?: (sessionId: string) => void,
  execution?: { silent?: boolean; peerBridge?: PeerRuntimeBridgeContext; sourceNode?: string },
): Promise<StreamAgentOutcome> {
  return runTurnEventStream(
    topicId,
    topicTitle,
    queryId,
    events,
    control,
    agentType,
    model,
    effort,
    userId,
    { appendSystemMessage, deliverAskCallbackToCaller, deliverAskError, redispatchInject },
    retryableSessionExpired,
    onSessionId,
    execution,
  );
}

/**
 * Re-run a deferred session-inject after its room freed up. Re-resolves the
 * topic (config/agent may have changed while queued) and dispatches through the
 * same priority path — if the room got busy again, startAiTurn just re-defers.
 */
function redispatchInject(inject: DeferredInject): void {
  const topics = getTopics();
  const topic = topics.find((t) => t.id === inject.topicId) as TopicDto | undefined;
  if (!topic?.agent) {
    logger.warn(
      { topicId: inject.topicId, origin: inject.origin },
      "ai: dropping deferred inject — topic gone or AI no longer invited",
    );
    try {
      inject.onSettled?.({
        queryId: "",
        kind: "error",
        error: "topic gone or AI no longer invited",
      });
    } catch (err) {
      logger.warn({ err, topicId: inject.topicId }, "ai: deferred settlement hook failed");
    }
    if (inject.forkHandle) cleanupAgentFork(inject.forkHandle);
    return;
  }
  startAiTurn({
    topic: {
      id: topic.id,
      title: topic.title,
      kind: topic.kind,
      description: topic.description,
      agent: topic.agent,
      defaultModel: topic.defaultModel,
      defaultEffort: topic.defaultEffort,
      aiMode: topic.aiMode,
      aiMention: topic.aiMention,
    },
    userId: inject.userId,
    prompt: inject.prompt,
    allowAutoContinue: false,
    origin: inject.origin,
    onDispatched: inject.onDispatched,
    requestId: inject.requestId,
    depth: inject.depth,
    silent: inject.silent,
    contextId: inject.contextId,
    agentOverride: inject.agentOverride,
    modelOverride: inject.modelOverride,
    effortOverride: inject.effortOverride,
    // Topic-owned turns carry undefined and re-resolve the newest durable
    // session here; isolated/external turns carry their explicit id.
    sessionId: inject.sessionId,
    sessionScope: inject.sessionScope,
    turnConcurrency: inject.turnConcurrency,
    forkHandle: inject.forkHandle,
    prepareSession: inject.prepareSession,
    cwd: inject.cwd,
    sessionName: inject.sessionName,
    sessionType: inject.sessionType,
    visualTools: inject.visualTools,
    fileDeliveryTools: inject.fileDeliveryTools,
    onSessionId: inject.onSessionId,
    onSessionReset: inject.onSessionReset,
    bridgeSessionFromHistory: inject.bridgeSessionFromHistory,
    onSettled: inject.onSettled,
    peerBridge: inject.peerBridge,
    sourceNode: inject.sourceNode,
    askReplySources: inject.askReplySources,
    _runtimeEpoch: inject.runtimeEpoch,
    _sessionRetried: inject._sessionRetried,
    from: inject.from,
  });
}

type AskPendingFileRef = {
  requestId?: string;
  contextId?: string;
  callerTopicId?: string;
  callerUserId?: string;
  pendingAsk?: {
    userId: PendingAskUserId;
    from: string;
    to: string;
    requestId?: string;
  };
  remoteReply?: import("#mcp/session-comm/peer-forward").RemoteReplyRoute;
};

async function clearPendingAskFile(
  pending: AskPendingFileRef,
  state?: "reply_ready" | "queued_for_caller" | "injecting_to_caller",
): Promise<void> {
  if (!pending.pendingAsk) return;
  try {
    const { clearPendingAsk, markPendingAskState } = await import("#storage/session-asks");
    if (state) markPendingAskState({ ...pending.pendingAsk, state });
    clearPendingAsk(pending.pendingAsk);
  } catch (err) {
    logger.warn({ err, pendingAsk: pending.pendingAsk }, "sessions: pending ask cleanup failed");
  }
}

async function markPendingAskFile(
  pending: AskPendingFileRef,
  state: "reply_ready" | "queued_for_caller" | "injecting_to_caller",
): Promise<void> {
  if (!pending.pendingAsk) return;
  try {
    const { markPendingAskState } = await import("#storage/session-asks");
    markPendingAskState({ ...pending.pendingAsk, state });
  } catch (err) {
    logger.warn(
      { err, pendingAsk: pending.pendingAsk, state },
      "sessions: pending ask mark failed",
    );
  }
}

/** Caller-side injection of an ask reply — delivers the target AI's answer (or
 *  error) back into the caller topic, triggering its AI when one is invited. */
export async function deliverAskCallbackToCaller(
  pending: AskPendingFileRef & {
    requestId: string;
    contextId?: string;
    callerTopicId: string;
    callerUserId: string;
  },
  sourceLabel: string,
  body: string,
  kind: "reply" | "error",
): Promise<boolean> {
  if (pending.remoteReply) {
    const { deliverPeerReply } = await import("#mcp/session-comm/peer-forward");
    return deliverPeerReply(pending.remoteReply, sourceLabel, body, kind);
  }
  const callerTopic = getTopic(pending.callerTopicId);
  const heading = kind === "error" ? `Error from ${sourceLabel}` : `Reply from ${sourceLabel}`;
  const prompt = `[${heading}]\n\n${body}`;

  await markPendingAskFile(pending, "reply_ready");

  if (!callerTopic?.agent) {
    try {
      appendAskReplyMessage(pending.callerTopicId, prompt);
      await clearPendingAskFile(pending);
      return true;
    } catch (err) {
      logger.warn(
        { err, requestId: pending.requestId, callerTopicId: pending.callerTopicId },
        "sessions: ask callback direct delivery failed",
      );
      return false;
    }
  }

  const queued = askReplyInjectBatcher.enqueue({
    topicId: pending.callerTopicId,
    userId: pending.callerUserId,
    prompt,
    origin: sourceLabel,
    requestId: pending.requestId,
    contextId: pending.contextId,
    sessionId: getTopicSessionId(pending.callerTopicId),
    askReplySources: [
      { from: sourceLabel, requestId: pending.requestId, contextId: pending.contextId },
    ],
    onDispatched: (queryId: string) => {
      void clearPendingAskFile(pending, "injecting_to_caller");
      logger.info(
        {
          requestId: pending.requestId,
          callerTopicId: pending.callerTopicId,
          callerQueryId: queryId,
          source: sourceLabel,
        },
        "sessions: batched ask callback dispatched to caller",
      );
    },
  });

  if (queued) {
    // Keep individual replies visible in topic history; only the model-facing
    // caller turn is coalesced into one prompt.
    appendAskReplyMessage(pending.callerTopicId, prompt, callerTopic.agent);
    await markPendingAskFile(pending, "queued_for_caller");
    return true;
  }

  // A replay can encounter the same request while its original callback is
  // still queued. That request is already owned; do not append it twice.
  if (interSessionQueue.hasRequest(pending.callerTopicId, pending.requestId)) {
    await markPendingAskFile(pending, "queued_for_caller");
    return true;
  }

  logger.warn(
    { requestId: pending.requestId, callerTopicId: pending.callerTopicId, source: sourceLabel },
    "sessions: ask callback could not enter caller batch; appending direct fallback",
  );
  appendAskReplyMessage(pending.callerTopicId, prompt, callerTopic.agent);
  await clearPendingAskFile(pending);
  return true;
}

/** Deliver an ask callback error to the caller topic (in-process, no-op if no pending ask). */
async function deliverAskError(queryId: string, sourceLabel: string, error: string) {
  try {
    const { resolveAskCallback } = await import("#runtime/ask-callbacks");
    const pending = resolveAskCallback(queryId);
    if (pending) {
      const prefix = pending.timedOut ? "⚠️ [Timeout - error notification was dropped]\n\n" : "";
      await deliverAskCallbackToCaller(pending, sourceLabel, `${prefix}${error}`, "error");
    }
  } catch {
    // Best-effort — don't let callback failure crash the main agent loop.
  }
}

function tryReconstructTopicRollout(opts: {
  topicId: string;
  topicTitle: string;
  userId: string;
  agent: AgentKind;
  sessionId: string | null | undefined;
  cwd: string;
  model: string;
  effort?: EffortLevel;
  allowFreshSession?: boolean;
}): string | null {
  const { topicId, topicTitle, userId, agent, sessionId, cwd, model, effort } = opts;
  if (!sessionId && !opts.allowFreshSession) return null;

  try {
    const entries = readConversation(userId, topicTitle);
    if (entries.length === 0) return null;
    const result = getRegistry(agent).writeRollout({
      cwd,
      entries,
      model,
      ...(effort ? { effort } : {}),
      ...(sessionId ? { reuseSessionId: sessionId } : {}),
    });
    logger.info(
      {
        topicId,
        agent,
        sessionId: result.sessionId,
        rolloutPath: result.rolloutPath,
        entries: entries.length,
      },
      sessionId
        ? "ai: session expired — rollout reconstructed from unified log"
        : "ai: provider session bridged from shared conversation log",
    );
    return result.sessionId;
  } catch (err) {
    logger.warn({ err, topicId, agent, sessionId }, "ai: session reconstruct failed");
    return null;
  }
}

function resolveSessionRetryId(opts: {
  topicId: string;
  topicTitle: string;
  userId: string;
  agent: AgentKind;
  sessionId: string | null | undefined;
  cwd: string;
  silent: boolean;
  model: string;
  effort?: EffortLevel;
  externalSessionOwner?: boolean;
  onSessionReset?: () => void;
}): string | null {
  const reconstructed = tryReconstructTopicRollout(opts);
  if (reconstructed) return reconstructed;
  if (opts.onSessionReset) opts.onSessionReset();
  else if (!opts.silent && !opts.externalSessionOwner) {
    clearTopicSessionId(opts.topicId, "session-expired");
  }
  logger.info(
    { topicId: opts.topicId, agent: opts.agent, hadSessionId: Boolean(opts.sessionId) },
    "ai: session expired — retrying with fresh session",
  );
  return null;
}

export interface AiTurnSettlement {
  queryId: string;
  kind: "completed" | "aborted" | "error";
  /** Distinguishes user preemption from an explicit stop for durable owners. */
  abortReason?: AbortReason;
  error?: string;
}

/** Execution controls shared by direct and injected turns. */
export interface AiTurnExecutionOptions {
  attachments?: string[];
  /** "user" (default) for a human message; otherwise the inject source topic. */
  origin?: string;
  /** Origin node for transcript echo suppression. */
  sourceNode?: string;
  /** Fired when the turn is actually dispatched, including after a defer. */
  onDispatched?: (queryId: string) => void;
  /** Inter-session requestId for queue dedup (session-inject only). */
  requestId?: string;
  /** Nesting depth/context metadata preserved across defer/requeue. */
  depth?: number;
  silent?: boolean;
  contextId?: string;
  modelOverride?: string;
  effortOverride?: EffortLevel;
  sessionId?: string | null;
  /** Explicitly isolate a provider conversation from the topic's durable session. */
  sessionScope?: "topic" | "isolated";
  /** Allow an isolated fork to run beside the topic's visible turn. Internal use only. */
  turnConcurrency?: "topic" | "isolated";
  forkHandle?: ForkHandle;
  /** Lazily create an isolated provider session immediately before execution. */
  prepareSession?: DeferredInject["prepareSession"];
  cwd?: string;
  /** Provider conversation namespace. Defaults to the visible topic title. */
  sessionName?: string;
  /** Tool/catalog scope. Defaults to manager or forum based on topic kind. */
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
  /** Adapter-granted access to Otium's visual panel tools. Default-deny. */
  visualTools?: boolean;
  /** Adapter-granted access to chat file-delivery tools. Default-deny. */
  fileDeliveryTools?: boolean;
  /** Own this turn's provider session without replacing the topic's main session. */
  onSessionId?: (sessionId: string) => void;
  /** Clear the externally-owned provider session after recovery fails. */
  onSessionReset?: () => void;
  /** Bridge a fresh provider session from this namespace's shared conversation log. */
  bridgeSessionFromHistory?: boolean;
  /** Observe the final non-retry outcome of this turn. */
  onSettled?: (result: AiTurnSettlement) => void;
  /** Route user-facing runtime mutations back to a placed room's hub. */
  peerBridge?: PeerRuntimeBridgeContext;
  askReplySources?: DeferredInject["askReplySources"];
  /** Internal source marker, e.g. FROM_AUTO_CONTINUE for config-change resumes. */
  from?: string;
}

export interface StartAiTurnParams extends AiTurnExecutionOptions {
  topic: AiTurnTopic;
  userId: string;
  prompt: string;
  allowAutoContinue: boolean;
  agentOverride?: AgentKind;
  /** Stable query id reserved before a cross-process handoff. Internal only. */
  _queryId?: string;
  /** Topic epoch captured when queued. Internal reset-fence guard only. */
  _runtimeEpoch?: number;
  _sessionRetried?: boolean;
}

export interface TriggerTopicAiTurnOptions extends AiTurnExecutionOptions {
  /** Run the injected turn without writing the inject prompt as a visible message. */
  hideInjectMessage?: boolean;
  /** Visible injected-message author. Execution still runs as `userId`. */
  injectAuthorId?: string;
  /** Identifies the subsystem that created the visible injected message. */
  injectSourceAdapter?: string;
  injectSourceNode?: string;
  injectSourceMessageId?: string;
}

const remoteInjectWaiters = new Map<string, ReturnType<typeof setInterval>>();

function serializableUserTurnExecution(params: StartAiTurnParams): RuntimeUserTurnExecution {
  return {
    runtimeEpoch: params._runtimeEpoch ?? getRuntimeTopicEpoch(params.topic.id),
    sourceRequestId: params.requestId,
    agentOverride: params.agentOverride,
    modelOverride: params.modelOverride,
    effortOverride: params.effortOverride,
    sessionId: params.sessionId,
    sessionIdSpecified: params.sessionId !== undefined,
    sessionScope: params.sessionScope,
    cwd: params.cwd,
    sessionName: params.sessionName,
    sessionType: params.sessionType,
    visualTools: params.visualTools,
    fileDeliveryTools: params.fileDeliveryTools,
    bridgeSessionFromHistory: params.bridgeSessionFromHistory,
    peerBridge: params.peerBridge,
    from: params.from,
  };
}

function waitToStartRemoteUserTurn(params: StartAiTurnParams, queryId: string): string {
  const previous = getRuntimeUserTurnRequest(params.topic.id);
  const execution = serializableUserTurnExecution(params);
  const queuedQueryId = enqueueRuntimeUserTurnRequest({
    topicId: params.topic.id,
    userId: params.userId,
    prompt: params.prompt,
    attachments: params.attachments,
    allowAutoContinue: params.allowAutoContinue,
    requestId: queryId,
    execution,
    topicEpoch: execution.runtimeEpoch,
  });
  if (previous && previous.requestId !== queuedQueryId) {
    WsHub.get().broadcastAborted(params.topic.id, previous.requestId, "superseded");
  }
  return queuedQueryId;
}

function announceQueuedUserTurn(params: StartAiTurnParams, queryId: string): void {
  try {
    params.onDispatched?.(queryId);
  } catch (err) {
    logger.warn({ err, topicId: params.topic.id, queryId }, "ai: queued dispatch hook failed");
  }
  if (!params.silent) WsHub.get().broadcastAiActive(params.topic.id, queryId);
}

function waitToDrainRemoteInject(topicId: string): void {
  if (remoteInjectWaiters.has(topicId)) return;
  const timer = setInterval(() => {
    if (
      getRuntimeTurnLease(topicId) ||
      getRoomQuery(topicId) ||
      isRuntimeTopicMaintenance(topicId)
    ) {
      return;
    }
    clearInterval(timer);
    remoteInjectWaiters.delete(topicId);
    const next = takeDeferredInject(topicId);
    if (next) redispatchInject(next);
  }, 100);
  timer.unref?.();
  remoteInjectWaiters.set(topicId, timer);
}

let durableTurnWorker: ReturnType<typeof setInterval> | null = null;
let durableTurnWorkerBusy = false;

async function drainOneDurableUserTurn(): Promise<void> {
  if (durableTurnWorkerBusy) return;
  durableTurnWorkerBusy = true;
  try {
    const request = claimNextRuntimeUserTurnRequest(RUNTIME_INSTANCE_ID);
    if (!request) return;
    const topic = getTopic(request.topicId);
    if (!topic?.agent) {
      completeRuntimeUserTurnRequest(request.topicId, request.requestId);
      return;
    }
    const execution = request.execution;
    const queryId = startAiTurn({
      topic,
      userId: request.userId,
      prompt: request.prompt,
      attachments: request.attachments,
      allowAutoContinue: request.allowAutoContinue,
      origin: "user",
      requestId: execution?.sourceRequestId,
      agentOverride: execution?.agentOverride,
      modelOverride: execution?.modelOverride,
      effortOverride: execution?.effortOverride,
      ...(execution?.sessionIdSpecified ? { sessionId: execution.sessionId } : {}),
      sessionScope: execution?.sessionScope,
      cwd: execution?.cwd,
      sessionName: execution?.sessionName,
      sessionType: execution?.sessionType,
      visualTools: execution?.visualTools,
      fileDeliveryTools: execution?.fileDeliveryTools,
      bridgeSessionFromHistory: execution?.bridgeSessionFromHistory,
      peerBridge: execution?.peerBridge,
      from: execution?.from,
      _queryId: request.requestId,
      _runtimeEpoch: execution?.runtimeEpoch ?? request.topicEpoch,
      onSettled: () => {
        completeRuntimeUserTurnRequest(request.topicId, request.requestId);
      },
    });
    if (!queryId) {
      releaseRuntimeUserTurnClaim(request.topicId, request.requestId, RUNTIME_INSTANCE_ID);
      return;
    }
    markRuntimeUserTurnRunning(request.topicId, request.requestId, RUNTIME_INSTANCE_ID, queryId);
  } finally {
    durableTurnWorkerBusy = false;
  }
}

/** Start a process-local claimant for durable user turns. Multiple processes
 * may run this worker; SQLite claims and topic leases choose exactly one. */
export function startDurableTurnRequestWorker(): () => void {
  if (durableTurnWorker) return () => {};
  durableTurnWorker = setInterval(() => {
    void drainOneDurableUserTurn();
  }, 100);
  durableTurnWorker.unref?.();
  void drainOneDurableUserTurn();
  return () => {
    if (!durableTurnWorker) return;
    clearInterval(durableTurnWorker);
    durableTurnWorker = null;
  };
}

/**
 * Start one AI turn for a topic: resolve agent/model/effort from
 * `config override > topic default`, run the agent, and stream events. Returns
 * the queryId.
 *
 * Caller guarantees the topic has an AI participant (agent set) —
 * people-only rooms are rejected upstream, so self-config / AI never
 * attach there.
 *
 * `allowAutoContinue`: when the AI changes this topic's config mid-turn via
 * runtime MCP, allow the runtime MCP context to enqueue ONE continue
 * turn. Follow-up turns pass false, so config changes cannot recurse.
 */
export function startAiTurn(params: StartAiTurnParams): string | null {
  // A caller may have retained an old DTO while another surface changed the
  // topic. Durable state is authoritative at the execution boundary.
  const storedTopic = getTopic(params.topic.id);
  if (!storedTopic || (!storedTopic.agent && !params.agentOverride)) {
    if (params.forkHandle) cleanupAgentFork(params.forkHandle);
    try {
      params.onSettled?.({
        queryId: "",
        kind: "error",
        error: storedTopic ? "topic no longer has an AI agent" : "topic no longer exists",
      });
    } catch (err) {
      logger.warn({ err, topicId: params.topic.id }, "ai: rejected-turn settlement hook failed");
    }
    return null;
  }
  const topic: TopicDto = storedTopic;
  const { userId, allowAutoContinue, onDispatched } = params;
  const prompt = params.prompt;
  const attachments = params.attachments;
  const execution = resolveTopicTurnExecution(topic, params);
  const sessionResolution = resolveTopicTurnSession(topic, params.sessionId, {
    agentOverride: params.agentOverride,
    modelOverride: params.modelOverride,
    effortOverride: params.effortOverride,
    silent: params.silent,
    sessionScope: params.sessionScope,
    sessionName: params.sessionName,
    sessionType: params.sessionType,
    hasFork: Boolean(params.forkHandle),
    preparesSession: Boolean(params.prepareSession),
    externalSessionOwner: Boolean(params.onSessionId),
  });
  let sessionId = sessionResolution.sessionId;
  // Topic-owned sessions are deliberately re-resolved after a defer. Isolated
  // and explicit sessions retain the id supplied by their owner.
  const deferredSessionId =
    params.sessionId === undefined && !sessionResolution.isolated ? undefined : sessionId;
  const origin = params.origin ?? "user";
  const sourceNode = params.sourceNode;
  const topicId = topic.id;
  const requestId = params.requestId;
  const depth = params.depth;
  const silent = params.silent;
  const contextId = params.contextId;
  const agentOverride = params.agentOverride;
  const modelOverride = params.modelOverride;
  const effortOverride = params.effortOverride;
  const sessionScope = params.sessionScope;
  const turnConcurrency = params.turnConcurrency ?? "topic";
  let forkHandle = params.forkHandle;
  const prepareSession = params.prepareSession;
  const cwd = params.cwd;
  const sessionName = params.sessionName ?? topic.title;
  const sessionType = params.sessionType;
  const visualTools = params.visualTools === true;
  const fileDeliveryTools = params.fileDeliveryTools === true;
  const onSessionId = params.onSessionId;
  const onSessionReset = params.onSessionReset;
  const bridgeSessionFromHistory = params.bridgeSessionFromHistory === true;
  const onSettled = params.onSettled;
  const peerBridge = params.peerBridge;
  const askReplySources = params.askReplySources;
  const sessionRetried = params._sessionRetried === true;
  const queryId = params._queryId ?? randomUUID();
  const roomId = turnConcurrency === "isolated" ? isolatedTurnRoomId(topicId, queryId) : topicId;
  const currentRuntimeEpoch = getRuntimeTopicEpoch(topic.id);
  const runtimeEpoch = params._runtimeEpoch ?? currentRuntimeEpoch;
  if (params._runtimeEpoch !== undefined && params._runtimeEpoch !== currentRuntimeEpoch) {
    if (params.forkHandle) cleanupAgentFork(params.forkHandle);
    if (!params.silent && params._queryId) {
      WsHub.get().broadcastAborted(topic.id, params._queryId, "stopped");
    }
    try {
      params.onSettled?.({ queryId, kind: "aborted", abortReason: AbortReason.External });
    } catch (err) {
      logger.warn({ err, topicId: topic.id, queryId }, "ai: stale-turn settlement hook failed");
    }
    logger.info(
      { topicId: topic.id, queryId, queuedEpoch: params._runtimeEpoch, currentRuntimeEpoch },
      "ai: dropped work queued before topic reset",
    );
    return null;
  }

  const deferCurrentTurn = (): boolean => {
    const queued = deferInject({
      topicId,
      runtimeEpoch,
      userId,
      prompt,
      origin,
      sourceNode,
      requestId,
      depth,
      silent,
      contextId,
      agentOverride,
      modelOverride,
      effortOverride,
      sessionId: deferredSessionId,
      sessionScope,
      turnConcurrency,
      forkHandle,
      prepareSession,
      cwd,
      sessionName,
      sessionType,
      visualTools,
      fileDeliveryTools,
      onSessionId,
      onSessionReset,
      bridgeSessionFromHistory,
      onSettled,
      peerBridge,
      askReplySources,
      _sessionRetried: sessionRetried,
      onDispatched,
      from: params.from,
    });
    if (!queued && forkHandle) cleanupAgentFork(forkHandle);
    return queued;
  };

  const rejectIsolatedTurnBeforeDispatch = (error: string): null => {
    if (forkHandle) cleanupAgentFork(forkHandle);
    try {
      onSettled?.({ queryId: "", kind: "error", error });
    } catch (err) {
      logger.warn({ err, topicId, queryId }, "ai: isolated-turn rejection hook failed");
    }
    return null;
  };

  if (turnConcurrency === "isolated" && isRuntimeTopicMaintenance(topicId)) {
    return rejectIsolatedTurnBeforeDispatch("target topic is being reset or deleted");
  }

  // Abort-on-new-message priority is scoped to the runtime room. Normal turns
  // share the topic room; a read-only ask fork owns a private room and can run
  // immediately beside the target topic's visible user turn.
  const decision = decideNewQuery(roomId, origin);
  if (decision.action === "defer") {
    if (turnConcurrency === "isolated") {
      return rejectIsolatedTurnBeforeDispatch("isolated turn slot is already occupied");
    }
    deferCurrentTurn();
    logger.info({ topicId, origin }, "ai: session-inject deferred behind running turn");
    return null;
  }
  if (decision.action === "remote-defer") {
    if (turnConcurrency === "isolated") {
      return rejectIsolatedTurnBeforeDispatch(
        "isolated turn slot is owned by another runtime process",
      );
    }
    if (deferCurrentTurn()) waitToDrainRemoteInject(topicId);
    logger.info(
      { topicId, origin, remoteQueryId: decision.running.queryId },
      "ai: session-inject deferred behind a turn owned by another process",
    );
    return null;
  }
  if (decision.action === "remote-abort-wait") {
    requestRuntimeTurnAbort(topicId, "internal");
    const queuedQueryId = waitToStartRemoteUserTurn(
      { ...params, topic, _runtimeEpoch: runtimeEpoch },
      queryId,
    );
    announceQueuedUserTurn({ ...params, topic }, queuedQueryId);
    logger.info(
      { topicId, queryId: queuedQueryId, remoteQueryId: decision.running.queryId },
      "ai: user turn waiting for another process to release the topic lease",
    );
    return queuedQueryId;
  }
  if (decision.action === "abort-replace") {
    const running = decision.running;
    // The preempted turn was itself a session-inject → re-queue it so the
    // inter-session work isn't lost; it resumes after the user's turn.
    if (running.injectParams) {
      const runningInject = running.injectParams;
      // A silent ask fork may already contain a partially-consumed provider
      // rollout. Requeue only its recipe, never that mutable rollout; the old
      // turn's finally block owns cleanup and the replay prepares a fresh fork.
      const requeuedInject = prepareInjectReplayAfterUserPreemption(runningInject);
      const queued = deferInject(requeuedInject);
      running.injectRequeued = queued;
      if (queued && runningInject.prepareSession) {
        // The queued copy retained requestId, so detach it from the dying
        // control. The async preparation may still publish an old fork after
        // this abort; finally must clean that fork instead of mistaking it for
        // the queued replay's resource.
        running.injectParams = { ...runningInject, requestId: undefined };
      } else if (!queued && runningInject.forkHandle) {
        cleanupAgentFork(runningInject.forkHandle);
        running.injectParams = {
          ...runningInject,
          forkHandle: undefined,
          sessionId: undefined,
        };
      }
    }
    running.abortReason = AbortReason.Internal;
    running.abortController.abort();
    logger.info(
      { topicId, supersededQueryId: running.queryId, supersededOrigin: running.origin },
      "ai: new user message superseded running turn",
    );
  }

  const abortController = new AbortController();
  const control: RoomQueryControl = {
    topicId,
    roomId,
    queryId,
    origin,
    prompt,
    attachments,
    sessionId,
    abortController,
    abortReason: AbortReason.None,
    // Preserve enough to re-queue this turn if a later user message preempts it.
    injectParams: isUserOrigin(origin)
      ? undefined
      : {
          topicId,
          runtimeEpoch,
          userId,
          prompt,
          origin,
          requestId,
          depth,
          silent,
          contextId,
          agentOverride,
          modelOverride,
          effortOverride,
          sessionId: deferredSessionId,
          sessionScope,
          turnConcurrency,
          forkHandle,
          prepareSession,
          cwd,
          sessionName,
          sessionType,
          visualTools,
          fileDeliveryTools,
          onSessionId,
          onSessionReset,
          bridgeSessionFromHistory,
          onSettled,
          peerBridge,
          askReplySources,
          _sessionRetried: sessionRetried,
          onDispatched,
          from: params.from,
        },
  };
  if (!setRoomQuery(control)) {
    // Another process won the lease between the decision and the atomic claim.
    // Preserve the same user-priority behavior and retry after that owner
    // releases (or its heartbeat expires).
    if (turnConcurrency === "isolated") {
      return rejectIsolatedTurnBeforeDispatch("failed to claim isolated turn slot");
    }
    if (isUserOrigin(origin)) {
      requestRuntimeTurnAbort(topicId, "internal");
      const queuedQueryId = waitToStartRemoteUserTurn(
        { ...params, topic, _runtimeEpoch: runtimeEpoch },
        queryId,
      );
      announceQueuedUserTurn({ ...params, topic }, queuedQueryId);
      return queuedQueryId;
    } else if (deferCurrentTurn()) {
      waitToDrainRemoteInject(topicId);
    }
    return null;
  }
  if (turnConcurrency === "topic") {
    try {
      writeQueryState(userId, topic.id, topic.title, prompt);
    } catch (err) {
      logger.warn({ err, topicId, userId }, "ai: failed to write active query state");
    }
  }
  try {
    onDispatched?.(queryId);
  } catch (err) {
    // Module/adapter observers are outside the turn's trust boundary. A broken
    // observer must not leave the room occupied without starting its provider.
    logger.warn({ err, topicId, queryId }, "ai: dispatch hook failed");
  }

  // Priority: config override > topic default. (Per-message slash overrides
  // were removed — switching is config-only now.) Cross-agent-stale models are
  // dropped to the agent's default by resolveModelForAgent.
  const override = getTopicConfig(topicId);
  const agentKind = execution.agent;
  const resolvedModel = execution.model;
  const resolvedEffort = execution.effort;

  const workspaceCwd = cwd ?? workspaceCwdFor(topicId);
  mkdirSync(workspaceCwd, { recursive: true });
  if (bridgeSessionFromHistory && !sessionId) {
    const bridgedSessionId = tryReconstructTopicRollout({
      topicId,
      topicTitle: sessionName,
      userId,
      agent: agentKind,
      sessionId: null,
      cwd: workspaceCwd,
      model: resolvedModel,
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
      allowFreshSession: true,
    });
    if (bridgedSessionId) {
      sessionId = bridgedSessionId;
      control.sessionId = bridgedSessionId;
      if (control.injectParams) control.injectParams.sessionId = bridgedSessionId;
      try {
        onSessionId?.(bridgedSessionId);
      } catch (err) {
        logger.warn(
          { err, topicId, queryId, agent: agentKind },
          "ai: isolated session owner rejected bridged provider session id",
        );
      }
    }
  }
  const promptAttachments = materializePromptAttachments(topicId, queryId, attachments);
  const promptWithFiles = promptWithAttachments(prompt, promptAttachments);
  const agentPrompt =
    topic.aiMode === "mention" && isUserOrigin(origin) && !silent
      ? buildMentionOnlyChannelPrompt({
          topicId,
          userId,
          prompt,
          promptWithFiles,
          hasSession: Boolean(sessionId),
        })
      : promptWithFiles;

  logger.info(
    {
      queryId,
      topicId,
      resolvedAgent: agentKind,
      resolvedModel,
      resolvedEffort,
      origin,
      silent: Boolean(silent),
      requestId,
      depth,
      resumeSessionId: sessionId ? sessionId.slice(0, 8) : null,
      freshSession: !sessionId,
      autoContinue: allowAutoContinue,
      attachmentCount: attachments?.length ?? 0,
      materializedAttachmentCount: promptAttachments.length,
    },
    "ai: dispatching query",
  );

  const aiLabel = getGlobalAiName();

  // R2: inject shared topic brief into system prompt for AI-invited topic turns.
  // In-memory process can read SQLite synchronously — zero latency for hot path.
  const topicRecord = getTopic(topicId);
  const systemPromptOpts = {
    aiLabel,
    topicTitle: topic.title,
    workspaceCwd,
    agentKind,
    currentModel: resolvedModel,
    currentEffort: resolvedEffort,
    description: topic.description,
    canSpawnSubagents:
      peerBridge?.canSpawnSubagents ?? (topicRecord?.kind === "agent" && !topicRecord.isSubagent),
    visualTools,
    fileDeliveryTools,
  };
  const isManager = topicRecord?.kind === "manager";
  const isMentionOnlyChannel = topic.aiMode === "mention" && !isManager;
  let systemPrompt = isManager
    ? buildManagerSystemPrompt(systemPromptOpts)
    : isMentionOnlyChannel
      ? buildChannelSystemPrompt(systemPromptOpts)
      : buildTopicSystemPrompt(systemPromptOpts);
  const memoryTopic =
    isMentionOnlyChannel || isManager ? topic : (getTopicMemoryOrigin(topicId) ?? topic);
  if (!isMentionOnlyChannel) {
    try {
      const resolvedBrief = resolveTopicBrief(memoryTopic.id, memoryTopic.title);
      if (resolvedBrief) {
        const { brief } = resolvedBrief;
        // #General is the workspace memory hub: its brief is the rolling digest the
        // archiver accumulates across ALL archived topics, and its files live in the
        // SHARED wiki root (getSharedWikiDir), not this topic's per-room workspace.
        const wikiDir = getSharedWikiDir();
        const briefFile = resolveWikiMirrorPath(
          join(wikiDir, "topic"),
          `${wikiBriefStorageKey(memoryTopic.title, memoryTopic.id)}.md`,
          (filename) => isTopicBriefFile(filename, memoryTopic.id),
          (filename) => isTopicBriefFile(filename, memoryTopic.id, memoryTopic.title),
        );
        const latestSummaryFile = brief.summaryDate
          ? resolveWikiMirrorPath(
              join(wikiDir, "summaries"),
              wikiSummaryFilename(brief.summaryDate, memoryTopic.title, memoryTopic.id),
              (filename) =>
                filename.startsWith(`${brief.summaryDate}-`) &&
                isTopicSummaryFile(filename, memoryTopic.id),
              (filename) =>
                filename.startsWith(`${brief.summaryDate}-`) &&
                isTopicSummaryFile(filename, memoryTopic.id, memoryTopic.title),
            )
          : null;
        systemPrompt += buildMemoryPromptSection({
          briefFile,
          wikiDir,
          hasFiles: true,
          latestSummaryFile,
          hasArchive: Boolean(brief.latestSummaryMd),
          isManager,
        });
      }
    } catch (err) {
      // Brief fetch failure is non-fatal — don't block the turn.
      logger.warn({ topicId, err }, "ai: failed to inject topic brief");
    }
  }
  const activeVisual = visualTools ? getActiveVisualForPrompt(topicId, userId) : null;
  if (activeVisual) {
    const label = activeVisual.title ? `"${activeVisual.title}"` : `#${activeVisual.index}`;
    const promptVisual = activeVisualHtmlForPrompt(activeVisual.content);
    const visualContentLabel =
      activeVisual.fence === "html"
        ? "HTML"
        : activeVisual.fence === "mermaid"
          ? "Mermaid source"
          : "visual content";
    systemPrompt += [
      "",
      "",
      "## Active Visual Panel",
      `The user is currently viewing a ${activeVisual.kind} visual ${label} (${activeVisual.index} of ${activeVisual.total}) in the side panel.`,
      "Its current source/content is shown below when available. Reference or modify it directly when the user asks to update the visual:",
      ...(promptVisual.omittedChars > 0
        ? [
            `The ${visualContentLabel} is truncated for prompt size; ${promptVisual.omittedChars} characters from the middle are omitted.`,
          ]
        : []),
      `\`\`\`${activeVisual.fence}`,
      promptVisual.html,
      "```",
    ].join("\n");
  }

  if (params.from === FROM_AUTO_CONTINUE) {
    systemPrompt +=
      "\n\n<system-reminder>이 턴은 설정 자동 조정(effort/model/agent) 후 자동 재개된 턴이다. effort/model/agent 난이도 재평가 및 설정 변경 없이 즉시 작업을 시작할 것.</system-reminder>";
  }

  if (!silent && !sessionRetried) {
    appendConversationEvent(userId, sessionName, agentKind, {
      type: "user_message",
      content: agentPrompt,
    });
  }

  // Wrap runAgent in a lazy async generator so we can `await ensurePlaywright`
  // at the moment streaming starts (startAiTurn itself is sync — it returns the
  // queryId immediately and streams in the background). Bring up a long-lived
  // Playwright and Background Bash MCPs for every non-manager topic. Without
  // a live `playwrightPort`,
  // mcp-config omits the
  // playwright entry entirely, so the agent connects but sees NO browser tools
  // — the "playwright active but tools missing" bug. The host must allocate
  // the port before building MCP config. Named browser profiles still control
  // which topics share a Chromium process and login state. Non-fatal.
  const configuredMcp = override?.mcp ?? [];
  const enabledMcp = withDefaultPlaywright(configuredMcp, isManager);
  const playwrightRequested = !isManager && enabledMcp.includes("playwright");
  const browserProfileOwner = isTopicBrowserProfileOwner(topic.id, userId);
  const wantsPlaywright = playwrightRequested && browserProfileOwner;
  const turnMcpEnabled = browserProfileOwner
    ? enabledMcp
    : enabledMcp.filter((name) => name !== "playwright");
  const wantsBgBash = !isManager && enabledMcp.includes("background-bash");
  async function* runWithPlaywright(): AsyncGenerator<UnifiedEvent> {
    if (prepareSession && !sessionId) {
      if (abortController.signal.aborted) return;
      try {
        const prepared = await prepareSession();
        sessionId = prepared.forkId;
        forkHandle = prepared;
        control.sessionId = prepared.forkId;
        if (control.injectParams) {
          control.injectParams.sessionId = prepared.forkId;
          control.injectParams.forkHandle = prepared;
        }
      } catch (err) {
        throw new Error(`failed to prepare isolated session: ${stringifyError(err)}`);
      }
      if (abortController.signal.aborted) return;
    }
    let playwrightPort: number | undefined;
    let playwrightCapability: string | undefined;
    let playwrightInstanceKey: string | undefined;
    let bgBashPort: number | undefined;
    if (wantsPlaywright) {
      try {
        playwrightInstanceKey = makeInstanceKey(userId, topic.id);
        // Pin before ensurePlaywright's asynchronous health check so an idle
        // sweep cannot evict the instance between validation and turn setup.
        pinPlaywrightInstance(playwrightInstanceKey);
        playwrightPort = await ensurePlaywright(userId, topic.id);
        playwrightCapability = getPlaywrightCapability(playwrightInstanceKey);
        if (!playwrightCapability) {
          throw new Error("browser MCP capability was not registered");
        }
      } catch (err) {
        logger.warn(
          { topicId, err },
          "ai: ensurePlaywright failed — proceeding without browser tools",
        );
        markPlaywrightUnavailable({
          userId,
          topic: topic.title,
          agent: agentKind,
        });
        if (!silent) notifyPlaywrightUnavailable(topicId);
      }
    }
    if (wantsBgBash) {
      try {
        bgBashPort = await ensureBgBash(userId, topic.id);
      } catch (err) {
        logger.warn(
          { topicId, err },
          "ai: ensureBgBash failed — proceeding without background bash tools",
        );
      }
    }
    let effectiveSystemPrompt = systemPrompt;
    if (playwrightRequested && !browserProfileOwner) {
      const ownerOnlyNote =
        "<system-reminder>Browser tools are unavailable in this turn because browser profiles are private to the topic owner. Do not attempt browser calls or ask to reuse the owner's login state.</system-reminder>";
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${ownerOnlyNote}`;
    }
    if (consumePlaywrightUnavailable(userId, topic.title)) {
      const playwrightNote =
        "<system-reminder>Playwright browser tools are UNAVAILABLE this turn. The `mcp__playwright__*` tools have been removed from this turn's catalog because the long-lived browser MCP could not be prepared. Do not attempt to call browser tools. If browser interaction is required, ask the user to retry shortly or use a non-browser alternative.</system-reminder>";
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${playwrightNote}`;
    }

    try {
      yield* runAgent({
        agent: agentKind,
        prompt: agentPrompt,
        attachments: promptAttachments,
        cwd: workspaceCwd,
        systemPrompt: effectiveSystemPrompt,
        sessionId,
        userId,
        session: sessionName,
        sessionType: sessionType ?? (isManager ? "manager" : "forum"),
        abortController,
        model: resolvedModel,
        effort: resolvedEffort,
        depth,
        silent,
        // Default OFF: with no override a topic loads only the REQUIRED servers (no
        // optional ones). Optional servers are opt-in per topic via the settings UI
        // / #General set_topic_mcp. `[]` = required-only; getForumMcpServers reserves
        // `null`/`undefined` for "all optional", which Otium no longer defaults to.
        mcpEnabled: turnMcpEnabled,
        playwrightPort,
        playwrightCapability,
        bgBashPort,
        topicId,
        queryId,
        wikiTopicId: memoryTopic.id,
        autoContinue: allowAutoContinue && !silent,
        visualTools,
        fileDeliveryTools,
        peerBridge,
      });
    } finally {
      if (playwrightInstanceKey) unpinPlaywrightInstance(playwrightInstanceKey);
    }
  }
  // Provider streams can stay silent while reasoning, starting MCPs, or
  // waiting on a long tool. Otium covers Claude thinking signals; this
  // channel-neutral fallback keeps every Negotium host alive for all agents.
  const providerEvents = runWithPlaywright();
  const events = silent ? providerEvents : withTurnSilenceHeartbeat(providerEvents);

  // Let UI show typing indicator while AI works (including tool calls / thinking).
  if (!silent) {
    WsHub.get().broadcastTyping(topicId, "ai");
    // Carry the queryId so clients can bind typing/tool UI to turns they did
    // not initiate (subagent task turns, session injects, other participants).
    WsHub.get().broadcastAiActive(topicId, queryId);
  }

  streamAgentEvents(
    topicId,
    topic.title,
    queryId,
    events,
    control,
    agentKind,
    resolvedModel,
    resolvedEffort,
    userId,
    !sessionRetried,
    onSessionId,
    { silent, peerBridge, sourceNode },
  )
    .then(async (outcome) => {
      if (outcome.kind === "session-expired") {
        if (!silent) WsHub.get().broadcastAborted(topicId, queryId, "stopped");
        const retrySessionId = resolveSessionRetryId({
          topicId,
          topicTitle: sessionName,
          userId,
          agent: agentKind,
          sessionId,
          cwd: workspaceCwd,
          silent: Boolean(silent),
          model: resolvedModel,
          ...(resolvedEffort ? { effort: resolvedEffort } : {}),
          externalSessionOwner: Boolean(onSessionId),
          onSessionReset,
        });
        logger.info(
          {
            topicId,
            prevQueryId: queryId,
            agent: agentKind,
            retrySessionId: retrySessionId ? retrySessionId.slice(0, 8) : null,
          },
          "ai: retrying query after session expiry",
        );
        if (!retrySessionId && prepareSession && forkHandle) {
          // The retry will invoke the recipe and mint a different rollout.
          // The expired fork is no longer in use after stream cleanup.
          cleanupAgentFork(forkHandle);
          forkHandle = undefined;
        }
        startAiTurn({
          topic,
          userId,
          prompt,
          attachments,
          allowAutoContinue,
          origin,
          onDispatched,
          requestId,
          depth,
          silent,
          contextId,
          agentOverride,
          modelOverride,
          effortOverride,
          sessionId: retrySessionId,
          sessionScope,
          turnConcurrency,
          forkHandle,
          // Keep the recipe so a later user preemption can replay from a
          // clean snapshot. A non-empty retrySessionId suppresses immediate
          // preparation in runWithPlaywright.
          prepareSession,
          cwd,
          sessionName,
          sessionType,
          visualTools,
          fileDeliveryTools,
          onSessionId,
          onSessionReset,
          bridgeSessionFromHistory,
          onSettled,
          peerBridge,
          askReplySources,
          _runtimeEpoch: runtimeEpoch,
          _sessionRetried: true,
        });
        return;
      }

      if (outcome.kind === "provider-error") {
        if (!silent) {
          // Provider failures are user-visible, but Otium does not automatically
          // switch the topic to another provider. Users may register multiple
          // providers and explicitly change this topic with /model.
          appendSystemMessage(
            topicId,
            `${classifyAgentError(outcome.error, agentKind)}\n\n다른 등록된 모델을 쓰려면 /model <model>로 바꾼 뒤 다시 보내세요.`,
          );
          WsHub.get().broadcastError(topicId, queryId, outcome.error);
        }
        await deliverAskError(queryId, topic.title, outcome.error);
        await settleSubagentFailure(queryId, classifyAgentError(outcome.error, agentKind));
        try {
          onSettled?.({ queryId, kind: "error", error: outcome.error });
        } catch (err) {
          logger.warn({ err, topicId, queryId }, "ai: turn settlement hook failed");
        }
        return;
      }
      const requeuedAfterUserPreemption = wasLocallyRequeuedAfterUserPreemption(
        outcome.kind,
        control,
      );
      if (requeuedAfterUserPreemption) return;
      try {
        onSettled?.({
          queryId,
          kind: outcome.kind === "aborted" ? "aborted" : "completed",
          ...(outcome.kind === "aborted" ? { abortReason: control.abortReason } : {}),
        });
      } catch (err) {
        logger.warn({ err, topicId, queryId }, "ai: turn settlement hook failed");
      }
    })
    .catch((err) => {
      logger.warn(
        { err, topicId, queryId, agent: agentKind, model: resolvedModel, silent },
        "ai: background stream task failed",
      );
      if (!silent) {
        WsHub.get().broadcastError(
          topicId,
          queryId,
          err instanceof Error ? err.message : "Agent process crashed",
        );
      }
      try {
        onSettled?.({
          queryId,
          kind: "error",
          error: err instanceof Error ? err.message : "Agent process crashed",
        });
      } catch (hookErr) {
        logger.warn({ err: hookErr, topicId, queryId }, "ai: turn settlement hook failed");
      }
    });

  return queryId;
}

export function wasLocallyRequeuedAfterUserPreemption(
  outcomeKind: StreamAgentOutcome["kind"],
  control: Pick<RoomQueryControl, "abortReason" | "injectParams" | "injectRequeued">,
): boolean {
  return (
    outcomeKind === "aborted" &&
    control.abortReason === AbortReason.Internal &&
    Boolean(control.injectParams) &&
    control.injectRequeued === true
  );
}

/**
 * Prepare an injected turn for replay after a user preempts it. An eager ask
 * can carry both its first fork and a regeneration recipe; only the recipe is
 * safe to retain once the provider may have partially consumed that fork.
 */
export function prepareInjectReplayAfterUserPreemption(
  runningInject: DeferredInject,
): DeferredInject {
  return runningInject.prepareSession
    ? { ...runningInject, sessionId: undefined, forkHandle: undefined }
    : runningInject;
}

/**
 * Programmatic AI turn trigger — used by session-comm (tell/ask) and any
 * internal consumer that needs to inject a prompt into a topic's AI pipeline.
 *
 * Returns the queryId so callers can track the result, or null if the topic
 * has no AI participant (AI not invited).
 */
export function triggerTopicAiTurn(
  topicId: string,
  userId: string,
  prompt: string,
  agentType?: AgentKind,
  opts?: TriggerTopicAiTurnOptions,
): string | null {
  const topics = getTopics();
  const topic = topics.find((t) => t.id === topicId) as TopicDto | undefined;
  if (!topic?.agent) return null;

  const topicCfg: AiTurnTopic = {
    id: topic.id,
    title: topic.title,
    kind: topic.kind,
    description: topic.description,
    agent: topic.agent,
    defaultModel: topic.defaultModel,
    defaultEffort: topic.defaultEffort,
    aiMode: topic.aiMode,
    aiMention: topic.aiMention,
  };
  const execution = resolveTopicTurnExecution(topicCfg, {
    agentOverride: agentType,
    modelOverride: opts?.modelOverride,
    effortOverride: opts?.effortOverride,
  });

  if (!opts?.silent && !opts?.hideInjectMessage) {
    // Show the injected message in the receiving topic immediately, decoupled
    // from when the AI turn actually runs — the turn may be deferred behind a
    // running user turn, but participants should see the inject arrive now.
    const now = new Date().toISOString();
    const injectMsg: MessageDto = {
      id: `tell-${randomUUID()}`,
      topicId,
      authorId: opts?.injectAuthorId ?? userId,
      sourceAdapter: opts?.injectSourceAdapter,
      sourceNode: opts?.injectSourceNode,
      sourceMessageId: opts?.injectSourceMessageId,
      authorName: execution.agent,
      text: prompt,
      agentType: execution.agent,
      model: execution.model,
      createdAt: now,
    };
    appendApiMessage(injectMsg);
    WsHub.get().broadcastMessage(topicId, injectMsg);
  }

  // Dispatch (or defer) the AI turn. origin != "user" → never preempts a
  // running user turn; the user keeps priority (Otium inter-session rule).
  return startAiTurn({
    topic: topicCfg,
    userId,
    prompt,
    attachments: opts?.attachments,
    allowAutoContinue: false,
    origin: opts?.origin ?? `inject:${agentType ?? topic.agent ?? "session"}`,
    onDispatched: opts?.onDispatched,
    requestId: opts?.requestId,
    depth: opts?.depth,
    silent: opts?.silent,
    contextId: opts?.contextId,
    agentOverride: agentType,
    modelOverride: opts?.modelOverride,
    effortOverride: opts?.effortOverride,
    sessionId: opts?.sessionId,
    sessionScope: opts?.sessionScope,
    turnConcurrency: opts?.turnConcurrency,
    forkHandle: opts?.forkHandle,
    prepareSession: opts?.prepareSession,
    cwd: opts?.cwd,
    sessionName: opts?.sessionName,
    sessionType: opts?.sessionType,
    visualTools: opts?.visualTools,
    fileDeliveryTools: opts?.fileDeliveryTools,
    onSessionId: opts?.onSessionId,
    onSessionReset: opts?.onSessionReset,
    bridgeSessionFromHistory: opts?.bridgeSessionFromHistory,
    onSettled: opts?.onSettled,
    peerBridge: opts?.peerBridge,
    sourceNode: opts?.injectSourceNode,
    askReplySources: opts?.askReplySources,
    from: opts?.from,
  });
}
