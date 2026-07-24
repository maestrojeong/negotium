import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { cleanupAgentFork } from "#agents/fork";
import { scheduleIdleArchiveForTopic } from "#agents/idle-archiver";
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
import {
  dispatchPeerRuntimeFile,
  dispatchPeerRuntimeVisual,
  flushPeerRuntimeEvents,
} from "#mcp/peer-bridge";
import { logger } from "#platform/logger";
import {
  clearRoomQuery,
  type DeferredInject,
  getRoomQuery,
  interSessionQueue,
  type RoomQueryControl,
  takeDeferredInject,
  wsAbortReason,
} from "#query/active-rooms";
import { clearQueryState } from "#query/state";
import { AbortReason } from "#query/types";
import type { AskPending } from "#runtime/ask-callbacks";
import { workspaceCwdFor } from "#runtime/attachments";
import { isSessionExpiredError, stringifyError } from "#runtime/errors";
import { upsertTaskPanelMessage } from "#runtime/tasks";
import { getTopicConfig } from "#runtime/topic-config";
import { nextUsageAlert } from "#runtime/usage-alert";
import {
  normalizeVisualTitle,
  storeTopicMediaVisual,
  storeTopicMermaidVisual,
  storeTopicVisual,
  topicVisualUrl,
} from "#runtime/visual-store";
import {
  buildImageHtml,
  buildMermaidHtml,
  buildVideoHtml,
  isPathInside,
  isVisualsShowHtmlTool,
  isVisualsShowImageTool,
  isVisualsShowMermaidTool,
  isVisualsShowVideoTool,
  normalizeMermaidTheme,
  normalizeToolUseId,
  resolveVisualMediaInput,
  stripMermaidFence,
} from "#runtime/visuals";
import { isSensitivePath } from "#security/sensitive-path";
import {
  appendApiMessage,
  softDeleteApiMessage,
  updateApiMessageUsage,
} from "#storage/api-messages";
import { getTopic, setTopicSessionId } from "#storage/api-topics";
import { recordUsage } from "#storage/token-stats";
import type { AgentKind, EffortLevel, PeerRuntimeBridgeContext, UnifiedEvent } from "#types";
import type { MessageDto } from "#types/api";

export type StreamAgentOutcome =
  | { kind: "completed" }
  | { kind: "aborted" }
  | { kind: "session-expired"; error: string }
  | { kind: "provider-error"; error: string };

export interface TurnEventStreamHooks {
  appendSystemMessage: (topicId: string, text: string) => MessageDto;
  deliverAskCallbackToCaller: (
    pending: AskPending,
    sourceLabel: string,
    body: string,
    kind: "reply" | "error",
  ) => Promise<boolean>;
  deliverAskError: (queryId: string, sourceLabel: string, error: string) => Promise<void>;
  redispatchInject: (inject: DeferredInject) => void;
}

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

export async function runTurnEventStream(
  topicId: string,
  topicTitle: string,
  queryId: string,
  events: AsyncGenerator<UnifiedEvent>,
  control: RoomQueryControl,
  agentType: AgentKind,
  model: string,
  _effort: EffortLevel | undefined,
  userId: string,
  hooks: TurnEventStreamHooks,
  retryableSessionExpired = true,
  onSessionId?: (sessionId: string) => void,
  execution?: {
    silent?: boolean;
    peerBridge?: PeerRuntimeBridgeContext;
    sourceNode?: string;
  },
): Promise<StreamAgentOutcome> {
  const { appendSystemMessage, deliverAskCallbackToCaller, deliverAskError, redispatchInject } =
    hooks;
  const abortController = control.abortController;
  const roomId = control.roomId ?? topicId;
  const hub = WsHub.get();
  const silent = execution?.silent ?? control.injectParams?.silent ?? false;
  const peerBridge = execution?.peerBridge ?? control.injectParams?.peerBridge;
  let errorOccurred = false;
  let terminalEmitted = false;
  let pendingSawDelta = false;
  let accumulatedText = "";
  let pendingText = "";
  let lastVisibleMessageId: string | null = null;
  const visibleMessageIds: string[] = [];
  let lastTaskPanelText: string | null = null;
  let syntheticToolCounter = 0;
  const providerToolIds = new Map<string, string>();
  const anonymousToolIds: string[] = [];
  const handledVisualToolResultIds = new Set<string>();
  const toolSummaryOptions = {
    cwd: control.injectParams?.cwd ?? workspaceCwdFor(topicId),
  };
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
  const emitPendingAssistantMessage = (usage?: MessageDto["usage"]): MessageDto | null => {
    const text = pendingText.trimEnd();
    pendingText = "";
    pendingSawDelta = false;
    if (silent || !text.trim()) return null;
    const message: MessageDto = {
      id: randomUUID(),
      topicId,
      authorId: "ai",
      text,
      queryId,
      agentType,
      model,
      sourceNode: execution?.sourceNode,
      usage,
      createdAt: new Date().toISOString(),
    };
    appendApiMessage(message);
    hub.broadcastMessage(topicId, message);
    lastVisibleMessageId = message.id;
    visibleMessageIds.push(message.id);
    return message;
  };
  const discardVisibleAssistantMessages = (): void => {
    for (const messageId of visibleMessageIds.splice(0)) {
      const deleted = softDeleteApiMessage(topicId, messageId);
      if (deleted) {
        hub.broadcastMessageUpdated(topicId, messageId, { deleted: true, text: "" });
      }
    }
    lastVisibleMessageId = null;
  };
  const broadcastStoredVisual = (
    event: Extract<UnifiedEvent, { type: "tool_use" }>,
    vizId: number,
    title: string | undefined,
    kind: "html" | "mermaid",
  ): void => {
    const toolUseId = bindToolUseId(event.toolUseId, `visual-${vizId}`);
    hub.broadcastToolCall(
      topicId,
      queryId,
      event.name,
      summarizeToolInput(event.name, event.input, toolSummaryOptions),
      formatToolUse(event.name, event.input),
      toolUseId,
    );
    const url = topicVisualUrl(topicId, vizId);
    hub.broadcastVisual(topicId, queryId, url, vizId, title ?? null, kind);
    hub.broadcastToolOutput(topicId, queryId, toolUseId, `Displayed: ${url}`);
    markVisualToolResultHandled(event.toolUseId);
  };
  const broadcastBridgedVisual = (
    event: Extract<UnifiedEvent, { type: "tool_use" }>,
    visual: { id: number; url: string },
  ): void => {
    const toolUseId = bindToolUseId(event.toolUseId, `visual-${visual.id}`);
    // The hub bridge already stored and broadcast the visual. Only complete
    // the worker-side tool row; forwarding another visual would duplicate it.
    hub.broadcastToolOutput(topicId, queryId, toolUseId, `Displayed: ${visual.url}`);
    markVisualToolResultHandled(event.toolUseId);
  };
  const failBridgedVisual = (
    event: Extract<UnifiedEvent, { type: "tool_use" }>,
    kind: "html" | "mermaid" | "image" | "video",
    reason: string,
  ): void => {
    logger.warn(
      { topicId, queryId, toolName: event.name, error: reason },
      "peer visual bridge failed",
    );
    hub.broadcastToolOutput(
      topicId,
      queryId,
      bindToolUseId(event.toolUseId),
      `Failed to display ${kind}: ${reason}`,
      true,
    );
    markVisualToolResultHandled(event.toolUseId);
  };
  let outcome: StreamAgentOutcome = { kind: "completed" };

  try {
    for await (const event of events) {
      if (abortController.signal.aborted) break;

      switch (event.type) {
        case "text_delta": {
          pendingSawDelta = true;
          const incoming = event.content;
          accumulatedText += incoming;
          pendingText += incoming;
          break;
        }
        case "text":
          if (!pendingSawDelta) {
            const incoming = event.content;
            accumulatedText += incoming;
            pendingText += incoming;
          }
          break;
        case "tool_use":
          // Provider text is streamed before the tool event that follows it.
          // Persist that completed segment first so every host receives the
          // original assistant → tool → assistant ordering instead of a block
          // of tools followed by one consolidated answer at turn completion.
          emitPendingAssistantMessage();
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
              if (peerBridge) {
                hub.broadcastToolCall(
                  topicId,
                  queryId,
                  event.name,
                  summarizeToolInput(event.name, event.input, toolSummaryOptions),
                  formatToolUse(event.name, event.input),
                  bindToolUseId(event.toolUseId),
                );
                if (!(await flushPeerRuntimeEvents(topicId))) {
                  failBridgedVisual(event, "html", "ordered event delivery is blocked");
                  break;
                }
                const bridged = await dispatchPeerRuntimeVisual({
                  bridge: peerBridge,
                  userId,
                  agent: agentType,
                  model,
                  kind: "html",
                  title,
                  html: input.html,
                });
                if (!bridged?.ok) {
                  failBridgedVisual(event, "html", bridged?.error ?? "visual bridge unavailable");
                  break;
                }
                broadcastBridgedVisual(event, bridged);
              } else {
                const vizId = storeTopicVisual(topicId, input.html, title, userId);
                broadcastStoredVisual(event, vizId, title, "html");
              }
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
              if (peerBridge) {
                hub.broadcastToolCall(
                  topicId,
                  queryId,
                  event.name,
                  summarizeToolInput(event.name, event.input, toolSummaryOptions),
                  formatToolUse(event.name, event.input),
                  bindToolUseId(event.toolUseId),
                );
                if (!(await flushPeerRuntimeEvents(topicId))) {
                  failBridgedVisual(event, "mermaid", "ordered event delivery is blocked");
                  break;
                }
                const bridged = await dispatchPeerRuntimeVisual({
                  bridge: peerBridge,
                  userId,
                  agent: agentType,
                  model,
                  kind: "mermaid",
                  title,
                  code,
                  theme,
                });
                if (!bridged?.ok) {
                  failBridgedVisual(
                    event,
                    "mermaid",
                    bridged?.error ?? "visual bridge unavailable",
                  );
                  break;
                }
                broadcastBridgedVisual(event, bridged);
              } else {
                const html = buildMermaidHtml(code, theme);
                const vizId = storeTopicMermaidVisual(topicId, code, html, title, userId);
                broadcastStoredVisual(event, vizId, title, "mermaid");
              }
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
                  true,
                );
                markVisualToolResultHandled(event.toolUseId);
              }
            };
            if (!silent) {
              hub.broadcastToolCall(
                topicId,
                queryId,
                event.name,
                summarizeToolInput(event.name, event.input, toolSummaryOptions),
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
              if (peerBridge) {
                if (!(await flushPeerRuntimeEvents(topicId))) {
                  failMediaVisual("ordered event delivery is blocked");
                  break;
                }
                const bridged = await dispatchPeerRuntimeVisual({
                  bridge: peerBridge,
                  userId,
                  agent: agentType,
                  model,
                  kind,
                  title,
                  fileId: media.fileId,
                  mimeType: media.mimeType,
                  source: media.source,
                });
                if (!bridged?.ok) {
                  failMediaVisual(bridged?.error ?? "visual bridge unavailable");
                  break;
                }
                broadcastBridgedVisual(event, bridged);
                break;
              }
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
                summarizeToolInput(event.name, event.input, toolSummaryOptions),
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
              event.isError,
            );
          }
          break;
        case "file":
          if (!silent && peerBridge) {
            const cwd = workspaceCwdFor(topicId);
            const path = isAbsolute(event.path) ? event.path : resolve(cwd, event.path);
            if (!isPathInside(cwd, path)) {
              logger.warn({ topicId, path }, "peer output file is outside the topic workspace");
              break;
            }
            let safePath: string;
            try {
              safePath = realpathSync(path);
              if (!statSync(safePath).isFile()) {
                logger.warn({ topicId, path }, "peer output path is not a regular file");
                break;
              }
            } catch (error) {
              logger.warn({ topicId, path, error }, "peer output file is unavailable");
              break;
            }
            if (isSensitivePath(safePath)) {
              logger.warn({ topicId, path: safePath }, "peer output file is sensitive");
              break;
            }
            const sent = await dispatchPeerRuntimeFile({
              bridge: peerBridge,
              userId,
              agent: agentType,
              model,
              path: safePath,
              source: event.source,
            });
            if (!sent?.ok)
              logger.warn({ error: sent?.error, path }, "peer output file bridge failed");
          } else if (!silent) {
            hub.broadcastFileReady(topicId, queryId, event.path, event.source);
          }
          break;
        case "result":
          if (event.usage) recordUsage(userId, topicTitle, event.usage);
          {
            const usage: MessageDto["usage"] = event.usage
              ? {
                  input: event.usage.inputTokens,
                  output: event.usage.outputTokens,
                  cachedInput: event.usage.cacheReadInputTokens,
                  context: event.usage.contextTokens,
                  contextWindow: event.usage.contextWindow,
                }
              : undefined;
            const finalMessage = emitPendingAssistantMessage(usage);
            // A tool-only ending has no trailing text segment to carry usage.
            // Attach it to the latest visible segment without changing its
            // timeline position; ai_done still carries the same usage to
            // remote hosts that do not accept generic message patches.
            if (!finalMessage && usage && lastVisibleMessageId) {
              const updated = updateApiMessageUsage(topicId, lastVisibleMessageId, usage);
              if (updated) {
                hub.broadcastMessageUpdated(topicId, lastVisibleMessageId, { usage });
              }
            }
          }
          if (!silent) {
            scheduleIdleArchiveForTopic(topicId, userId);
            hub.broadcastDone(
              topicId,
              queryId,
              event.usage
                ? {
                    input: event.usage.inputTokens,
                    output: event.usage.outputTokens,
                    cachedInput: event.usage.cacheReadInputTokens,
                    context: event.usage.contextTokens,
                    contextWindow: event.usage.contextWindow,
                  }
                : undefined,
              { agent: agentType, model },
            );
            // Session-bloat notice: warn once when the provider reports at
            // least 80% context occupancy. Skip subagent rooms (transient).
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
                : event.toolName === "working"
                  ? `Working… ${elapsed}s`
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
        case "reasoning":
          if (!silent) hub.broadcastReasoning(topicId, queryId, event.content);
          break;
        case "tasks":
          if (!silent && getRoomQuery(topicId)?.queryId === queryId) {
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
      // Keep text already spoken before either an explicit stop or a new user
      // message supersedes the turn. Adapters clean up transient tool status
      // separately when they receive ai_aborted.
      emitPendingAssistantMessage();
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
      } else {
        // The replay receives a new queryId and registers a fresh callback.
        // Drop the superseded mapping now so it cannot leak until TTL expiry.
        const { resolveAskCallback } = await import("#runtime/ask-callbacks");
        resolveAskCallback(queryId);
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
    const discardIncompleteSegments =
      outcome.kind === "session-expired" ||
      outcome.kind === "provider-error" ||
      (!terminalEmitted && !abortController.signal.aborted);
    if (discardIncompleteSegments) discardVisibleAssistantMessages();
    if (!terminalEmitted && !silent) {
      hub.broadcastDone(topicId, queryId, undefined, { agent: agentType, model });
    }
    // Release the room slot — but only if a newer turn hasn't already taken it
    // (abort-and-replace sets a fresh control synchronously before this dying
    // turn's generator unwinds here). Query-state cleanup follows the same
    // guard so a superseded turn cannot delete its replacement's state file.
    const stillCurrent = getRoomQuery(roomId)?.queryId === queryId;
    clearRoomQuery(roomId, queryId);
    cancelPendingAskUserQuestions(topicId, queryId);
    if (stillCurrent && roomId === topicId) clearQueryState(userId, topicId, topicTitle);
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
    if (roomId === topicId && outcome.kind !== "session-expired" && !getRoomQuery(topicId)) {
      const next = takeDeferredInject(topicId);
      if (next) redispatchInject(next);
    }
  }
  return outcome;
}
