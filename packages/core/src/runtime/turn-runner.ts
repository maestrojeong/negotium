/**
 * Turn runner — executes one AI turn for a topic and streams its events.
 *
 * Port of otium's `api/routes/ai.ts` with the REST route table removed and the
 * WsHub replaced by the channel-agnostic RuntimeBus (`#bus`). Peer/placement
 * execution (placed rooms, peer bridges) was removed: this node runs every
 * turn locally.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { cleanupAgentFork, type ForkHandle } from "#agents/fork";
import { scheduleIdleArchiveForTopic } from "#agents/idle-archiver";
import { runAgent } from "#agents/index";
import { cancelPendingAskUserQuestions } from "#agents/mcp-tools/ask-user";
import {
  settleSubagentFailure,
  settleSubagentSuccess,
  takeSubagentWatch,
} from "#agents/mcp-tools/spawn-subagent";
import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { formatToolUse, summarizeToolInput } from "#agents/tool-format";
import { WsHub } from "#bus";
import { ensureBgBash } from "#platform/background-bash/manager";
import { FROM_AUTO_CONTINUE } from "#platform/constants";
import { logger } from "#platform/logger";
import { consumePlaywrightUnavailable, markPlaywrightUnavailable } from "#platform/mcp-config";
import { ensurePlaywright } from "#platform/playwright/manager";
import {
  buildChannelSystemPrompt,
  buildManagerSystemPrompt,
  buildMemoryPromptSection,
  buildTopicSystemPrompt,
} from "#prompts/builders";
import {
  clearRoomQuery,
  type DeferredInject,
  DeferredInjectBatcher,
  decideNewQuery,
  deferInject,
  getRoomQuery,
  interSessionQueue,
  isUserOrigin,
  type RoomQueryControl,
  setRoomQuery,
  takeDeferredInject,
  wsAbortReason,
} from "#query/active-rooms";
import { clearQueryState, writeQueryState } from "#query/state";
import { AbortReason } from "#query/types";
import {
  materializePromptAttachments,
  promptWithAttachments,
  workspaceCwdFor,
} from "#runtime/attachments";
import { buildMentionOnlyChannelPrompt } from "#runtime/channel-context";
import { classifyAgentError, isSessionExpiredError, stringifyError } from "#runtime/errors";
import { upsertTaskPanelMessage } from "#runtime/tasks";
import { getTopicConfig } from "#runtime/topic-config";
import { nextUsageAlert } from "#runtime/usage-alert";
import {
  getActiveVisualForPrompt,
  normalizeVisualTitle,
  storeTopicMediaVisual,
  storeTopicMermaidVisual,
  storeTopicVisual,
  topicVisualUrl,
} from "#runtime/visual-store";
import {
  activeVisualHtmlForPrompt,
  buildImageHtml,
  buildMermaidHtml,
  buildVideoHtml,
  isVisualsShowHtmlTool,
  isVisualsShowImageTool,
  isVisualsShowMermaidTool,
  isVisualsShowVideoTool,
  normalizeMermaidTheme,
  normalizeToolUseId,
  resolveVisualMediaInput,
  stripMermaidFence,
} from "#runtime/visuals";
import { appendApiMessage } from "#storage/api-messages";
import { getTopicBrief } from "#storage/api-topic-brief";
import {
  clearTopicSessionId,
  getTopic,
  getTopicMemoryOrigin,
  getTopicSessionId,
  setTopicSessionId,
} from "#storage/api-topics";
import { getGlobalAiName } from "#storage/app-settings";
import { appendConversationEvent, readConversation } from "#storage/conversations";
import type { PendingAskUserId } from "#storage/session-asks";
import { getSharedWikiDir } from "#storage/wiki";
import { getTopics } from "#topics/derive";
import type { AgentKind, EffortLevel, UnifiedEvent } from "#types";
import type { MessageDto, TopicDto } from "#types/api";

// 분해된 헬퍼 모듈 재노출 — 기존 @/api/routes/ai 소비자(테스트 포함) 경로 유지
export * from "#agents/model-catalog";
export * from "#runtime/attachments";
export * from "#runtime/channel-context";
export * from "#runtime/errors";
export * from "#runtime/tasks";
export * from "#runtime/visuals";

// In-flight AI turns are tracked room-keyed (topicId → control) in
// #query/active-rooms so a new user message on a room can supersede the
// running turn (Otium abort-on-new-message). See startAiTurn / abortRoom.
const PLAYWRIGHT_UNAVAILABLE_NOTICE_COOLDOWN_MS = 5 * 60_000;
const ASK_REPLY_INJECT_BATCH_MS = 500;
const playwrightUnavailableNoticeAt = new Map<string, number>();

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

type StreamAgentOutcome =
  | { kind: "completed" }
  | { kind: "aborted" }
  | { kind: "session-expired"; error: string }
  | { kind: "provider-error"; error: string };

function sessionEventMatchesCurrentExecution(
  topicId: string,
  queryId: string,
  agent: AgentKind,
  model: string,
): boolean {
  if (getRoomQuery(topicId)?.queryId !== queryId) return false;
  const topic = getTopic(topicId);
  if (!topic || topic.agent !== agent) return false;
  const registry = getRegistry(agent);
  const configuredModel = resolveModelForAgent(
    agent,
    getTopicConfig(topicId)?.model ?? topic.defaultModel,
    registry,
  );
  return configuredModel === model;
}

async function streamAgentEvents(
  topicId: string,
  topicTitle: string,
  queryId: string,
  events: AsyncGenerator<UnifiedEvent>,
  control: RoomQueryControl,
  agentType: AgentKind,
  model: string,
  _effort: EffortLevel | undefined,
  userId: string,
  retryableSessionExpired = true,
  onSessionId?: (sessionId: string) => void,
): Promise<StreamAgentOutcome> {
  const abortController = control.abortController;
  const hub = WsHub.get();
  const silent = control.injectParams?.silent ?? false;
  let errorOccurred = false;
  let terminalEmitted = false;
  let sawDelta = false;
  let accumulatedText = "";
  let lastTaskPanelText: string | null = null;
  let syntheticToolCounter = 0;
  const providerToolIds = new Map<string, string>();
  const anonymousToolIds: string[] = [];
  const handledVisualToolResultIds = new Set<string>();
  const nextSyntheticToolUseId = () => `tool-${queryId}-${++syntheticToolCounter}`;
  const bindToolUseId = (providerToolUseId?: string, fallback?: string): string => {
    const providerId = normalizeToolUseId(providerToolUseId);
    if (providerId) {
      const existing = providerToolIds.get(providerId);
      if (existing) return existing;
      const clientId = fallback ?? providerId;
      providerToolIds.set(providerId, clientId);
      return clientId;
    }
    const clientId = fallback ?? nextSyntheticToolUseId();
    anonymousToolIds.push(clientId);
    return clientId;
  };
  const resolveToolResultId = (providerToolUseId: string): string => {
    const providerId = normalizeToolUseId(providerToolUseId);
    if (providerId) {
      const existing = providerToolIds.get(providerId);
      if (existing) return existing;
      const anonymousClientId = anonymousToolIds.shift();
      if (anonymousClientId) {
        providerToolIds.set(providerId, anonymousClientId);
        return anonymousClientId;
      }
      return providerId;
    }
    return anonymousToolIds.shift() ?? nextSyntheticToolUseId();
  };
  const markVisualToolResultHandled = (providerToolUseId?: string) => {
    const providerId = normalizeToolUseId(providerToolUseId);
    if (providerId) handledVisualToolResultIds.add(providerId);
  };
  const isVisualToolResultHandled = (providerToolUseId: string): boolean => {
    const providerId = normalizeToolUseId(providerToolUseId);
    return providerId ? handledVisualToolResultIds.has(providerId) : false;
  };
  let outcome: StreamAgentOutcome = { kind: "completed" };

  try {
    for await (const event of events) {
      if (abortController.signal.aborted) break;

      switch (event.type) {
        case "text_delta":
          sawDelta = true;
          accumulatedText += event.content;
          break;
        case "text":
          if (!sawDelta) {
            accumulatedText += event.content;
          }
          break;
        case "tool_use":
          // Match both the bare name (Codex reports MCP server/tool separately)
          // and each provider's public MCP-name form.
          if (isVisualsShowHtmlTool(event.name)) {
            const input = event.input as { html?: unknown; title?: unknown };
            if (typeof input.html !== "string" || input.html.trim().length === 0) {
              logger.warn(
                { topicId, queryId, toolName: event.name },
                "show_html tool_use missing html input; ignoring visual render",
              );
              break;
            }
            if (!silent) {
              const title = normalizeVisualTitle(input.title);
              const vizId = storeTopicVisual(topicId, input.html, title, userId);
              const toolUseId = bindToolUseId(event.toolUseId, `visual-${vizId}`);
              const label = formatToolUse(event.name, event.input);
              hub.broadcastToolCall(
                topicId,
                queryId,
                event.name,
                summarizeToolInput(event.name, event.input),
                label,
                toolUseId,
              );
              const url = topicVisualUrl(topicId, vizId);
              hub.broadcastVisual(topicId, queryId, url, vizId, title ?? null, "html");
              hub.broadcastToolOutput(topicId, queryId, toolUseId, `Displayed: ${url}`);
              markVisualToolResultHandled(event.toolUseId);
            }
          } else if (isVisualsShowMermaidTool(event.name)) {
            const input = event.input as { code?: unknown; title?: unknown; theme?: unknown };
            const code = typeof input.code === "string" ? stripMermaidFence(input.code) : "";
            if (!code) {
              logger.warn(
                { topicId, queryId, toolName: event.name },
                "show_mermaid tool_use missing code input; ignoring visual render",
              );
              break;
            }
            if (!silent) {
              const title = normalizeVisualTitle(input.title);
              const theme = normalizeMermaidTheme(input.theme);
              const html = buildMermaidHtml(code, theme);
              const vizId = storeTopicMermaidVisual(topicId, code, html, title, userId);
              const toolUseId = bindToolUseId(event.toolUseId, `visual-${vizId}`);
              const label = formatToolUse(event.name, event.input);
              hub.broadcastToolCall(
                topicId,
                queryId,
                event.name,
                summarizeToolInput(event.name, event.input),
                label,
                toolUseId,
              );
              const url = topicVisualUrl(topicId, vizId);
              hub.broadcastVisual(topicId, queryId, url, vizId, title ?? null, "mermaid");
              hub.broadcastToolOutput(topicId, queryId, toolUseId, `Displayed: ${url}`);
              markVisualToolResultHandled(event.toolUseId);
            }
          } else if (isVisualsShowImageTool(event.name) || isVisualsShowVideoTool(event.name)) {
            const input = event.input as {
              file_path?: unknown;
              file_id?: unknown;
              title?: unknown;
              alt?: unknown;
            };
            const kind = isVisualsShowImageTool(event.name) ? "image" : "video";
            const toolUseId = bindToolUseId(event.toolUseId);
            const label = formatToolUse(event.name, event.input);
            const failMediaVisual = (reason: string) => {
              logger.warn(
                { topicId, queryId, toolName: event.name, error: reason },
                "media visual tool_use could not render visual",
              );
              if (!silent) {
                hub.broadcastToolOutput(
                  topicId,
                  queryId,
                  toolUseId,
                  `Failed to display ${kind}: ${reason}`,
                );
                markVisualToolResultHandled(event.toolUseId);
              }
            };
            if (!silent) {
              hub.broadcastToolCall(
                topicId,
                queryId,
                event.name,
                summarizeToolInput(event.name, event.input),
                label,
                toolUseId,
              );
            }
            if (silent) break;
            const media = resolveVisualMediaInput(topicId, input);
            if ("error" in media) {
              failMediaVisual(media.error);
              break;
            }
            if (kind === "image" && !media.mimeType.startsWith("image/")) {
              failMediaVisual(`expected image media, got ${media.mimeType}`);
              break;
            }
            if (kind === "video" && !media.mimeType.startsWith("video/")) {
              failMediaVisual(`expected video media, got ${media.mimeType}`);
              break;
            }
            try {
              const title = normalizeVisualTitle(input.title);
              const html =
                kind === "image"
                  ? buildImageHtml(
                      typeof input.alt === "string" ? input.alt : (title ?? "Visual image"),
                    )
                  : buildVideoHtml(media.mimeType);
              const vizId = storeTopicMediaVisual({
                topicId,
                kind,
                html,
                title,
                fileId: media.fileId,
                mimeType: media.mimeType,
                source: media.source,
                activeUserId: userId,
              });
              const url = topicVisualUrl(topicId, vizId);
              hub.broadcastVisual(topicId, queryId, url, vizId, title ?? null, kind);
              hub.broadcastToolOutput(topicId, queryId, toolUseId, `Displayed: ${url}`);
              markVisualToolResultHandled(event.toolUseId);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              failMediaVisual(reason);
            }
          } else {
            // Label is computed server-side (single source of truth) so the
            // client renders the same "Bash(npm test)" convention everywhere.
            const label = formatToolUse(event.name, event.input);
            const toolUseId = bindToolUseId(event.toolUseId);
            if (!silent) {
              hub.broadcastToolCall(
                topicId,
                queryId,
                event.name,
                summarizeToolInput(event.name, event.input),
                label,
                toolUseId,
              );
            }
          }
          break;
        case "tool_result":
          if (isVisualToolResultHandled(event.toolUseId)) break;
          if (!silent) {
            hub.broadcastToolOutput(
              topicId,
              queryId,
              resolveToolResultId(event.toolUseId),
              event.content,
            );
          }
          break;
        case "file":
          if (!silent) hub.broadcastFileReady(topicId, queryId, event.path, event.source);
          break;
        case "result":
          // Persist the AI's final answer so it survives reloads / shows in
          // history. The client receives this as the canonical message event.
          if (!silent && accumulatedText.trim()) {
            const aiMsg: MessageDto = {
              id: randomUUID(),
              topicId,
              authorId: "ai",
              text: accumulatedText.trimEnd(),
              queryId,
              agentType,
              model,
              usage: event.usage
                ? { input: event.usage.inputTokens, output: event.usage.outputTokens }
                : undefined,
              createdAt: new Date().toISOString(),
            };
            appendApiMessage(aiMsg);
            hub.broadcastMessage(topicId, aiMsg);
          }
          if (!silent) {
            scheduleIdleArchiveForTopic(topicId, userId);
            hub.broadcastDone(
              topicId,
              queryId,
              event.usage
                ? { input: event.usage.inputTokens, output: event.usage.outputTokens }
                : undefined,
              { agent: agentType, model },
            );
            // Session-bloat notice: warn once per 1M-token step so the owner can
            // /new before context bloat hurts quality/cost. Skip General (cannot
            // be reset) and subagent rooms (transient).
            const finishedTopic = getTopic(topicId);
            if (event.usage && finishedTopic?.kind !== "manager" && !finishedTopic?.isSubagent) {
              const usageAlert = nextUsageAlert(userId, topicId, topicTitle, event.usage);
              if (usageAlert) appendSystemMessage(topicId, usageAlert);
            }
          }
          terminalEmitted = true;

          // ── Ask callback: route reply to the caller topic ──────────
          {
            const { resolveAskCallback } = await import("#runtime/ask-callbacks");
            const pending = resolveAskCallback(queryId);
            if (pending) {
              const sourceLabel = topicTitle;
              const replyText = pending.timedOut
                ? `⚠️ [Timeout - reply from ${sourceLabel} took too long and was dropped]`
                : accumulatedText.trim() || "(처리됨, 별도 응답 없음)";
              await deliverAskCallbackToCaller(pending, sourceLabel, replyText, "reply");
            }
          }

          // ── Subagent settlement: card → completed, result → parent room ──
          {
            const watch = takeSubagentWatch(queryId);
            if (watch) void settleSubagentSuccess(watch, accumulatedText.trim());
          }

          break;
        case "error":
          logger.warn(
            { topicId, queryId, agentType, model, silent, error: event.content },
            "ai: provider returned error",
          );
          terminalEmitted = true;
          errorOccurred = true;
          if (retryableSessionExpired && isSessionExpiredError(event.content)) {
            outcome = { kind: "session-expired", error: event.content };
            return outcome;
          }
          outcome = { kind: "provider-error", error: event.content };
          if (silent) deliverAskError(queryId, topicTitle, event.content);
          return outcome;
        case "status":
          if (!silent) hub.broadcastToolStatus(topicId, queryId, "status", event.content);
          break;
        case "user_message":
          break;
        case "tool_progress":
          if (!silent) {
            const elapsed = Math.max(0, Math.round(event.elapsed));
            // "thinking" is the provider's extended-thinking heartbeat, not a
            // tool — label it as a live thinking state instead of "running".
            const label =
              event.toolName === "thinking"
                ? `Thinking… ${elapsed}s`
                : `${event.toolName} running ${elapsed}s`;
            hub.broadcastToolStatus(topicId, queryId, "progress", label, {
              toolName: event.toolName,
              elapsed,
            });
          }
          break;
        case "tool_use_summary":
          if (!silent) hub.broadcastToolStatus(topicId, queryId, "summary", event.summary);
          break;
        case "tasks":
          if (!silent) {
            lastTaskPanelText = upsertTaskPanelMessage(
              topicId,
              queryId,
              event.tasks,
              lastTaskPanelText,
            );
          }
          break;
        case "session":
          // Persist visible topic turns only. Silent ask_session forks use
          // temporary session ids and must not clobber the topic's durable
          // session; visible tell/reply injects do belong to the main topic
          // session, same as user messages.
          if (!silent && onSessionId && getRoomQuery(topicId)?.queryId === queryId) {
            try {
              // A user turn may preempt and requeue this injected turn. Carry
              // the newest provider session into that deferred copy.
              if (control.injectParams) control.injectParams.sessionId = event.sessionId;
              onSessionId(event.sessionId);
            } catch (err) {
              logger.warn(
                { err, topicId, queryId, agentType },
                "ai: isolated session owner rejected provider session id",
              );
            }
          } else if (
            !silent &&
            sessionEventMatchesCurrentExecution(topicId, queryId, agentType, model)
          ) {
            setTopicSessionId(topicId, event.sessionId, {
              reason: "provider-session-event",
              queryId,
              agent: agentType,
            });
          } else if (!silent) {
            logger.info(
              { topicId, queryId, agentType, model, sessionId: event.sessionId.slice(0, 8) },
              "ai: ignored stale provider session event after execution config changed",
            );
          }
          break;
      }
    }

    if (!errorOccurred && abortController.signal.aborted) {
      // reason discriminates supersede (new user message) vs explicit stop.
      const isSuperseded = control.abortReason === AbortReason.Internal;
      if (!silent && !isSuperseded && accumulatedText.trim()) {
        const partialMsg: MessageDto = {
          id: randomUUID(),
          topicId,
          authorId: "ai",
          text: accumulatedText.trimEnd(),
          queryId,
          agentType,
          model,
          createdAt: new Date().toISOString(),
        };
        appendApiMessage(partialMsg);
        hub.broadcastMessage(topicId, partialMsg);
      }
      if (!silent) hub.broadcastAborted(topicId, queryId, wsAbortReason(control.abortReason));
      terminalEmitted = true;
      outcome = { kind: "aborted" };
      // Internal abort = this turn is being replaced and (if it was a session
      // inject) re-queued — NOT a failure. Suppress the asker notification so
      // the caller doesn't get a spurious "Aborted" followed by the real reply
      // from the re-queued turn. Only External/stop notifies the asker.
      if (control.abortReason !== AbortReason.Internal) {
        deliverAskError(queryId, topicTitle, "Aborted");
        void settleSubagentFailure(queryId, "중지됨 (사용자가 실행을 멈췄습니다)");
      }
    }
  } catch (err) {
    const msg = stringifyError(err) || "Unknown agent error";
    logger.warn({ err, topicId, queryId, agentType, model, silent }, "ai: stream failed");
    terminalEmitted = true;
    if (retryableSessionExpired && isSessionExpiredError(msg)) {
      outcome = { kind: "session-expired", error: msg };
    } else {
      outcome = { kind: "provider-error", error: msg };
      if (silent) deliverAskError(queryId, topicTitle, msg);
    }
  } finally {
    if (!terminalEmitted && !silent) {
      hub.broadcastDone(topicId, queryId, undefined, { agent: agentType, model });
    }
    // Release the room slot — but only if a newer turn hasn't already taken it
    // (abort-and-replace sets a fresh control synchronously before this dying
    // turn's generator unwinds here). Query-state cleanup follows the same
    // guard so a superseded turn cannot delete its replacement's state file.
    const stillCurrent = getRoomQuery(topicId)?.queryId === queryId;
    clearRoomQuery(topicId, queryId);
    cancelPendingAskUserQuestions(topicId, queryId);
    if (stillCurrent) clearQueryState(userId, topicTitle);
    // Stop typing only if this turn still owns the room. A superseded turn may
    // finish cleanup after its replacement already broadcast a fresh start.
    if (!silent && stillCurrent) hub.broadcastTyping(topicId, "");
    const forkHandle = control.injectParams?.forkHandle;
    const forkRequestId = control.injectParams?.requestId;
    if (
      forkHandle &&
      outcome.kind !== "session-expired" &&
      (!forkRequestId || !interSessionQueue.hasRequest(topicId, forkRequestId))
    ) {
      cleanupAgentFork(forkHandle);
    }
    // Drain one deferred session-inject if the room is now idle. If a
    // replacement turn already occupies the slot, leave it queued — that
    // turn's finally will drain it when it completes.
    if (outcome.kind !== "session-expired" && !getRoomQuery(topicId)) {
      const next = takeDeferredInject(topicId);
      if (next) redispatchInject(next);
    }
  }
  return outcome;
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
    // A visible inject may have waited behind a user turn which advanced the
    // topic session after enqueue. Resume that newest main session. Silent
    // ask forks and externally-owned sessions retain their isolated id.
    sessionId:
      !inject.silent && !inject.forkHandle && !inject.onSessionId
        ? getTopicSessionId(topic.id)
        : inject.sessionId,
    forkHandle: inject.forkHandle,
    cwd: inject.cwd,
    sessionName: inject.sessionName,
    sessionType: inject.sessionType,
    onSessionId: inject.onSessionId,
    onSessionReset: inject.onSessionReset,
    bridgeSessionFromHistory: inject.bridgeSessionFromHistory,
    onSettled: inject.onSettled,
    askReplySources: inject.askReplySources,
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
): Promise<void> {
  const callerTopic = getTopic(pending.callerTopicId);
  const heading = kind === "error" ? `Error from ${sourceLabel}` : `Reply from ${sourceLabel}`;
  const prompt = `[${heading}]\n\n${body}`;

  await markPendingAskFile(pending, "reply_ready");

  if (!callerTopic?.agent) {
    try {
      appendAskReplyMessage(pending.callerTopicId, prompt);
      await clearPendingAskFile(pending);
    } catch (err) {
      logger.warn(
        { err, requestId: pending.requestId, callerTopicId: pending.callerTopicId },
        "sessions: ask callback direct delivery failed",
      );
    }
    return;
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
    return;
  }

  // A replay can encounter the same request while its original callback is
  // still queued. That request is already owned; do not append it twice.
  if (interSessionQueue.hasRequest(pending.callerTopicId, pending.requestId)) {
    await markPendingAskFile(pending, "queued_for_caller");
    return;
  }

  logger.warn(
    { requestId: pending.requestId, callerTopicId: pending.callerTopicId, source: sourceLabel },
    "sessions: ask callback could not enter caller batch; appending direct fallback",
  );
  appendAskReplyMessage(pending.callerTopicId, prompt, callerTopic.agent);
  await clearPendingAskFile(pending);
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

export interface AiTurnTopic {
  id: string;
  title: string;
  kind?: TopicDto["kind"];
  description?: string | null;
  agent?: AgentKind | null;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  aiMode?: TopicDto["aiMode"];
  aiMention?: boolean;
}

export interface AiTurnSettlement {
  queryId: string;
  kind: "completed" | "aborted" | "error";
  error?: string;
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
export function startAiTurn(params: {
  topic: AiTurnTopic;
  userId: string;
  prompt: string;
  attachments?: string[];
  allowAutoContinue: boolean;
  /** "user" (default) for a human message; otherwise the inject source topic. */
  origin?: string;
  /** Fired with the queryId at the moment the turn is actually dispatched
   *  (immediately, or later if deferred behind a running turn). */
  onDispatched?: (queryId: string) => void;
  /** Inter-session requestId for queue dedup (session-inject only). */
  requestId?: string;
  /** Nesting depth/context metadata preserved across defer/requeue. */
  depth?: number;
  silent?: boolean;
  contextId?: string;
  agentOverride?: AgentKind;
  modelOverride?: string;
  effortOverride?: EffortLevel;
  sessionId?: string | null;
  forkHandle?: ForkHandle;
  cwd?: string;
  /** Provider conversation namespace. Defaults to the visible topic title. */
  sessionName?: string;
  /** Tool/catalog scope. Defaults to manager or forum based on topic kind. */
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
  /** Own this turn's provider session without replacing the topic's main session. */
  onSessionId?: (sessionId: string) => void;
  /** Clear the externally-owned provider session after recovery fails. */
  onSessionReset?: () => void;
  /** Bridge a fresh provider session from this namespace's shared conversation log. */
  bridgeSessionFromHistory?: boolean;
  /** Observe the final non-retry outcome of this turn. */
  onSettled?: (result: AiTurnSettlement) => void;
  askReplySources?: DeferredInject["askReplySources"];
  _sessionRetried?: boolean;
  /** FROM_AUTO_CONTINUE: appends a system-reminder that blocks re-evaluation of model/effort. */
  from?: string;
}): string | null {
  const { topic, userId, allowAutoContinue, onDispatched } = params;
  const prompt = params.prompt;
  const attachments = params.attachments;
  let sessionId = params.sessionId;
  const origin = params.origin ?? "user";
  const topicId = topic.id;
  const requestId = params.requestId;
  const depth = params.depth;
  const silent = params.silent;
  const contextId = params.contextId;
  const agentOverride = params.agentOverride;
  const modelOverride = params.modelOverride;
  const effortOverride = params.effortOverride;
  const forkHandle = params.forkHandle;
  const cwd = params.cwd;
  const sessionName = params.sessionName ?? topic.title;
  const sessionType = params.sessionType;
  const onSessionId = params.onSessionId;
  const onSessionReset = params.onSessionReset;
  const bridgeSessionFromHistory = params.bridgeSessionFromHistory === true;
  const onSettled = params.onSettled;
  const askReplySources = params.askReplySources;
  const sessionRetried = params._sessionRetried === true;

  // Abort-on-new-message priority (Otium handler.ts L175-208). At most one
  // in-flight turn per room: a user message preempts whatever is running; a
  // session-inject waits its turn behind the user.
  const decision = decideNewQuery(topicId, origin);
  if (decision.action === "defer") {
    const queued = deferInject({
      topicId,
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
      sessionId,
      forkHandle,
      cwd,
      sessionName,
      sessionType,
      onSessionId,
      onSessionReset,
      bridgeSessionFromHistory,
      onSettled,
      askReplySources,
      _sessionRetried: sessionRetried,
      onDispatched,
      from: params.from,
    });
    if (!queued && forkHandle) cleanupAgentFork(forkHandle);
    logger.info({ topicId, origin }, "ai: session-inject deferred behind running turn");
    return null;
  }
  if (decision.action === "abort-replace") {
    const running = decision.running;
    // The preempted turn was itself a session-inject → re-queue it so the
    // inter-session work isn't lost; it resumes after the user's turn.
    if (running.injectParams) {
      const queued = deferInject(running.injectParams);
      if (!queued && running.injectParams.forkHandle) {
        cleanupAgentFork(running.injectParams.forkHandle);
        running.injectParams = {
          ...running.injectParams,
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

  const queryId = randomUUID();

  const abortController = new AbortController();
  const control: RoomQueryControl = {
    topicId,
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
          sessionId,
          forkHandle,
          cwd,
          sessionName,
          sessionType,
          onSessionId,
          onSessionReset,
          bridgeSessionFromHistory,
          onSettled,
          askReplySources,
          _sessionRetried: sessionRetried,
          onDispatched,
          from: params.from,
        },
  };
  setRoomQuery(control);
  try {
    writeQueryState(userId, topic.title, prompt);
  } catch (err) {
    logger.warn({ err, topicId, userId }, "ai: failed to write active query state");
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
  const configuredAgent = agentOverride ?? topic.agent;
  const agentKind: AgentKind = (configuredAgent ?? "maestro") as AgentKind;
  const registry = getRegistry(agentKind);
  const requestedModel = modelOverride ?? override?.model ?? topic.defaultModel;
  const resolvedModel = resolveModelForAgent(agentKind, requestedModel, registry);
  const requestedEffort = (effortOverride ?? override?.effort ?? topic.defaultEffort) as
    | EffortLevel
    | undefined;
  const resolvedEffort =
    requestedEffort && registry.validateEffort(requestedEffort)
      ? requestedEffort
      : registry.defaultEffort;

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
    description: topic.description,
    canSpawnSubagents: topicRecord?.kind === "agent" && !topicRecord.isSubagent,
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
      const brief = getTopicBrief(memoryTopic.id);
      if (brief) {
        // #General is the workspace memory hub: its brief is the rolling digest the
        // archiver accumulates across ALL archived topics, and its files live in the
        // SHARED wiki root (getSharedWikiDir), not this topic's per-room workspace.
        const wikiDir = getSharedWikiDir();
        systemPrompt += buildMemoryPromptSection({
          topicId: memoryTopic.id,
          wikiDir,
          hasFiles: true,
          latestSummaryFile: brief.summaryDate
            ? `${wikiDir}/summaries/${brief.summaryDate}-${memoryTopic.id}.md`
            : null,
          hasArchive: Boolean(brief.latestSummaryMd),
          isManager,
        });
      }
    } catch (err) {
      // Brief fetch failure is non-fatal — don't block the turn.
      logger.warn({ topicId, err }, "ai: failed to inject topic brief");
    }
  }
  const activeVisual = getActiveVisualForPrompt(topicId, userId);
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
  // Playwright MCP for this topic when (and only when) playwright is in the
  // topic's enabled set: without a live `playwrightPort`, mcp-config omits the
  // playwright entry entirely, so the agent connects but sees NO browser tools
  // — the "playwright active but tools missing" bug. The host must allocate
  // the port before building MCP config. Gated on the opt-in whitelist
  // so topics that don't use playwright never spawn a Chromium. Non-fatal.
  const enabledMcp = override?.mcp ?? [];
  const wantsPlaywright = !isManager && enabledMcp.includes("playwright");
  const wantsBgBash = !isManager && enabledMcp.includes("background-bash");
  async function* runWithPlaywright(): AsyncGenerator<UnifiedEvent> {
    let playwrightPort: number | undefined;
    let bgBashPort: number | undefined;
    if (wantsPlaywright) {
      try {
        playwrightPort = await ensurePlaywright(userId, topic.id);
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
    if (consumePlaywrightUnavailable(userId, topic.title)) {
      const playwrightNote =
        "<system-reminder>Playwright browser tools are UNAVAILABLE this turn. The `mcp__playwright__*` tools have been removed from this turn's catalog because the long-lived browser MCP could not be prepared. Do not attempt to call browser tools. If browser interaction is required, ask the user to retry shortly or use a non-browser alternative.</system-reminder>";
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${playwrightNote}`;
    }

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
      mcpEnabled: enabledMcp,
      playwrightPort,
      bgBashPort,
      topicId,
      queryId,
      wikiTopicId: memoryTopic.id,
      autoContinue: allowAutoContinue && !silent,
    });
  }
  const events = runWithPlaywright();

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
  )
    .then(async (outcome) => {
      if (outcome.kind === "session-expired") {
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
          forkHandle,
          cwd,
          sessionName,
          sessionType,
          onSessionId,
          onSessionReset,
          bridgeSessionFromHistory,
          onSettled,
          askReplySources,
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
          WsHub.get().broadcastDone(topicId, queryId, undefined, {
            agent: agentKind,
            model: resolvedModel,
          });
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
      const requeuedAfterUserPreemption =
        outcome.kind === "aborted" &&
        control.abortReason === AbortReason.Internal &&
        Boolean(control.injectParams);
      if (requeuedAfterUserPreemption) return;
      try {
        onSettled?.({
          queryId,
          kind: outcome.kind === "aborted" ? "aborted" : "completed",
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
  opts?: {
    /** Inject source label (e.g. the from-topic name). Anything != "user"
     *  marks the turn as a session-inject so it defers behind a running user
     *  turn instead of preempting it. */
    origin?: string;
    /** Called with the AI turn's queryId at the moment it is actually
     *  dispatched — immediately, or later if it was deferred behind a running
     *  turn. Used by ask_session to register its reply callback against the
     *  real queryId even when the inject is queued. */
    onDispatched?: (queryId: string) => void;
    /** Inter-session requestId for queue dedup (ask/tell). */
    requestId?: string;
    /** Queue metadata preserved when an inject defers or is preempted. */
    depth?: number;
    silent?: boolean;
    contextId?: string;
    modelOverride?: string;
    effortOverride?: EffortLevel;
    sessionId?: string | null;
    forkHandle?: ForkHandle;
    cwd?: string;
    /** Provider conversation namespace override for isolated internal sessions. */
    sessionName?: string;
    /** MCP/tool scope override for isolated internal sessions. */
    sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
    /** Persist provider session ids outside the topic's main session slot. */
    onSessionId?: (sessionId: string) => void;
    /** Clear an externally-owned session after expiry reconstruction fails. */
    onSessionReset?: () => void;
    /** Build a missing provider session from the shared conversation namespace. */
    bridgeSessionFromHistory?: boolean;
    /** Observe the final non-retry outcome of this turn. */
    onSettled?: (result: AiTurnSettlement) => void;
    askReplySources?: DeferredInject["askReplySources"];
    /** Internal source marker, e.g. FROM_AUTO_CONTINUE for config-change resumes. */
    from?: string;
    /** Run the injected turn without writing the inject prompt as a visible message. */
    hideInjectMessage?: boolean;
    /** Visible injected-message author. Execution still runs as `userId`. */
    injectAuthorId?: string;
    attachments?: string[];
  },
): string | null {
  const topics = getTopics();
  const topic = topics.find((t) => t.id === topicId) as TopicDto | undefined;
  if (!topic?.agent) return null;

  const topicCfg: AiTurnTopic = {
    id: topic.id,
    title: topic.title,
    kind: topic.kind,
    description: topic.description,
    agent: agentType ?? topic.agent,
    defaultModel: topic.defaultModel,
    defaultEffort: topic.defaultEffort,
    aiMode: topic.aiMode,
    aiMention: topic.aiMention,
  };
  const sessionId =
    opts?.sessionId !== undefined
      ? opts.sessionId
      : opts?.silent
        ? undefined
        : getTopicSessionId(topicId);

  if (!opts?.silent && !opts?.hideInjectMessage) {
    // Show the injected message in the receiving topic immediately, decoupled
    // from when the AI turn actually runs — the turn may be deferred behind a
    // running user turn, but participants should see the inject arrive now.
    const now = new Date().toISOString();
    const injectMsg: MessageDto = {
      id: `tell-${randomUUID()}`,
      topicId,
      authorId: opts?.injectAuthorId ?? userId,
      authorName: agentType ?? topic.agent,
      text: prompt,
      agentType: agentType ?? topic.agent,
      model: topic.defaultModel,
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
    sessionId,
    forkHandle: opts?.forkHandle,
    cwd: opts?.cwd,
    sessionName: opts?.sessionName,
    sessionType: opts?.sessionType,
    onSessionId: opts?.onSessionId,
    onSessionReset: opts?.onSessionReset,
    bridgeSessionFromHistory: opts?.bridgeSessionFromHistory,
    onSettled: opts?.onSettled,
    askReplySources: opts?.askReplySources,
    from: opts?.from,
  });
}
