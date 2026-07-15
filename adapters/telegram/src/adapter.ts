/**
 * startTelegramAdapter — turn a negotium node into a Telegram bot.
 *
 * SINGLE-OPERATOR ADAPTER BY DESIGN: unlike clawgram (multi-user production
 * bot), this adapter serves exactly one human owner — the fixed negotium
 * `userId` (default "local"). `allowedUsers` is just a gate for that owner's
 * Telegram id(s) (one person, possibly several devices); there is no
 * per-user scoping, role logic, or cross-user isolation in commands.
 *
 * The adapter owns exactly the channel glue:
 *   - (chatId, forum thread) → negotium topic mapping (a chat/thread shows
 *     one topic; a topic may fan out to several chats/threads), persisted in
 *     SQLite so restarts keep routing established threads,
 *   - inbound text/media → whitelist check → slash commands (/new /topics
 *     /agent /fork /spawn /del /del! /abort) → attachment download into the
 *     topic workspace (core `ingestAttachment`) → persisted user message +
 *     AI turn; `/load` binds a topic created by another simultaneous adapter;
 *     voice notes are transcribed via core's local pipeline (or a
 *     custom `transcribe` hook); album items (shared `media_group_id`) are
 *     debounce-buffered into ONE combined turn,
 *   - RuntimeBus "message" events → markdown-to-Telegram-HTML rendering,
 *     4096-char splitting, per-chunk plain-text fallback, produced-file
 *     delivery ([FILE:] tags → sendPhoto/sendDocument, sensitive paths
 *     blocked), optional turn footer, and a durable SQLite retry outbox for
 *     transient send failures (429/5xx/network),
 *   - "ai-status" ai_active events → best-effort typing indicator,
 *   - FORUM MODE (`forumChatId` set): runtime-created topics — spawn_subagent
 *     children, /new from another host, ask-fork rooms — materialize as real
 *     Telegram forum threads in that supergroup, and `topic-deleted` removes
 *     the thread (best-effort).
 *
 * It deliberately does NOT construct the Telegram client, start the node's
 * HTTP/MCP server, or call `startSessionInboxWorker` — the embedding app
 * owns process-level wiring. Keeping those out of the library is what makes
 * it composable (any polling/webhook client works) and testable (tests
 * inject a fake client and never touch the network).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import {
  type AgentKind,
  abortRoom,
  appendApiMessage,
  composeAttachmentPrompt,
  createDerivedTopic,
  deleteTopicCascade,
  ensurePersonalGeneral,
  errMsg,
  extractFileTagPaths,
  getTopic,
  getTopicByNameForUser,
  type IngestedAttachment,
  ingestAttachment,
  isAgentKind,
  isSensitivePath,
  isTopicVisible,
  isTranscriptionConfigured,
  listTopics,
  logger,
  type MessageDto,
  type RegisterTopicOptions,
  registerTopic,
  renderTurnFooter,
  restartTopicSession,
  runtimeBus,
  startAiTurn,
  stripFileTags,
  TopicArchiveRequiredError,
  type TopicDto,
  TopicTitleConflictError,
  TopicValidationError,
  transcribeAudio,
} from "@negotium/core";
import { openMappingStore } from "@/mapping-store";
import { renderOutbound } from "@/render";
import type {
  TelegramChatMember,
  TelegramClientLike,
  TelegramIncomingMessage,
  TelegramMyChatMemberUpdate,
} from "@/types";

export interface TelegramAdapterOptions {
  client: TelegramClientLike;
  /** negotium user the bot acts as; defaults to "local". */
  userId?: string;
  /** Telegram user-id whitelist; empty/absent = allow all. */
  allowedUsers?: string[];
  /** Agent for auto-created topics; unset = registerTopic's default (maestro). */
  defaultAgent?: "claude" | "codex" | "maestro";
  /** Turn dispatcher override for remote hosts and deterministic tests. */
  startTurn?: typeof startAiTurn;
  /** Topic title for a chat/thread; default `tg-{chatId}` / `tg-{chatId}-{threadId}`. */
  topicTitleFor?: (chatId: number, threadId?: number) => string;
  /**
   * FORUM MODE: id of a forum supergroup. Runtime-created topics materialize
   * as forum threads there via `client.createForumTopic`, and their bus
   * messages are delivered into the thread. Requires the client's forum
   * surface; without it the adapter logs a warning and behaves like DM mode.
   */
  forumChatId?: number;
  /** Mapping-db path override (tests); default `${DATA_DIR}/adapter-telegram.db`. */
  mappingDbPath?: string;
  /** Refresh interval for Telegram's short-lived typing action. Default 4s. */
  typingHeartbeatMs?: number;
  /** Per-delivery watchdog: a send that hasn't settled in this long is
   *  abandoned so the topic's queue keeps draining. Override is a test hook;
   *  default 60s. */
  sendTimeoutMs?: number;
  /** Voice-note transcriber. Defaults to core's local faster-whisper pipeline
   *  (`transcribeAudio`); when neither this option nor the core pipeline is
   *  configured, voice messages get a polite "not configured" reply. */
  transcribe?: (filePath: string) => Promise<string | null>;
  /** Append core's one-line turn footer (agent · model · tokens) to final AI
   *  replies. Default off. */
  footer?: boolean;
  /** Durable retry-outbox tuning (test hooks; production defaults are fine). */
  outbox?: {
    pollMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  };
  /** Media-group (album) buffering: `debounceMs` after the last item (albums
   *  arrive over ~1s), `maxWaitMs` hard cap on total buffering so a trickling
   *  group can't defer its turn forever. Test hooks; defaults 1s / 3s. */
  mediaGroup?: {
    debounceMs?: number;
    maxWaitMs?: number;
  };
}

export interface TelegramAdapterHandle extends NegotiumAdapterHandle<"telegram"> {
  /** Bind an existing visible Negotium topic to a Telegram chat/thread. */
  loadTopic(chatId: number, topicId: string, threadId?: number): boolean;
  /** Remove only the Telegram binding; the shared Negotium topic is preserved. */
  unloadTopic(chatId: number, threadId?: number): boolean;
  /** Unsubscribe from the RuntimeBus, stop the retry flusher, close the
   *  mapping store, and ignore further inbound messages. In-flight forum
   *  thread creations are abandoned (their continuations check the stopped
   *  flag before touching the store or sending). */
  stop(): void;
}

/** One live (chat, thread?) → topic binding. `threadId` is echoed back on
 *  replies as `message_thread_id` so forum answers land in their thread.
 *  Holds ids only — the TopicDto is re-read from storage when needed, so
 *  mappings loaded from the persistent store need no hydration pass. */
interface ChatMapping {
  topicId: string;
  chatId: number;
  threadId?: number;
}

/** One outbound unit: rendered text plus files referenced by [FILE:] tags. */
interface OutboundPayload {
  text: string;
  files: string[];
  runtimeMessageId?: string;
}

interface DeliveredMessageRef {
  chatId: number;
  threadId?: number;
  messageId: number;
  kind: "text" | "media";
  text?: string;
  html?: boolean;
  footer?: string;
}

interface DeliveredTextRef {
  messageId: number;
  kind: "text";
  text: string;
  html: boolean;
  footer?: string;
}

interface DeliveredMediaRef {
  messageId: number;
  kind: "media";
}

/** Telegram caps forum topic names at 128 characters. */
const FORUM_TOPIC_NAME_MAX = 128;
/** DM fallback: how far up the parentTopicId chain to look for a mapped
 *  ancestor (spawn_subagent children can nest). */
const MAX_PARENT_HOPS = 5;
const DEFAULT_SEND_TIMEOUT_MS = 60_000;
/** Extensions delivered via sendPhoto (mirrors clawgram's IMAGE_EXTS). */
const PHOTO_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function onboardingGuide(botUsername?: string): string {
  const identity = botUsername ? `\nBot username: @${botUsername.replace(/^@/, "")}\n` : "\n";
  return (
    "Welcome to Negotium. This DM is your General manager: chat naturally here to create, " +
    "delegate work to, stop, or delete topics.\n\n" +
    "Connect a Telegram workspace:\n" +
    "1. Create a supergroup and enable Topics.\n" +
    "2. Add this bot to the group.\n" +
    '3. Promote the bot to administrator and enable "Manage Topics".\n' +
    "4. The group connects automatically; no /connect command is needed.\n" +
    identity +
    "After connection, use the group's General topic as the manager and each forum topic as " +
    "an independent agent conversation."
  );
}

function isChatAdmin(member: TelegramChatMember): boolean {
  return member.status === "administrator" || member.status === "creator";
}

function canManageTopics(member: TelegramChatMember): boolean {
  return (
    member.status === "creator" ||
    (member.status === "administrator" && member.can_manage_topics === true)
  );
}

function isManageTopicsPermissionError(info: TelegramErrorInfo): boolean {
  return /not enough rights|need administrator rights|chat_admin_required|manage topics/i.test(
    info.description,
  );
}

function defaultTopicTitle(chatId: number, threadId?: number): string {
  return threadId === undefined ? `tg-${chatId}` : `tg-${chatId}-${threadId}`;
}

/** Extract the argument portion of a bot command, e.g. "/new foo bar" → "foo bar" */
function extractCommandArg(text: string): string {
  return text.split(/\s+/).slice(1).join(" ").trim();
}

/** The parts of a Telegram API error the adapter classifies on.
 *  `node-telegram-bot-api` throws errors with `response.statusCode` (Bot API
 *  HTTP status) and `response.body` = the API's `{ description, parameters }`
 *  payload; `message` repeats the description ("ETELEGRAM: 400 Bad Request:
 *  can't parse entities…") and network failures carry `code` ("EFATAL",
 *  "ETIMEDOUT", …). All fields are read defensively. */
interface TelegramErrorInfo {
  status?: number;
  code?: string;
  description: string;
  retryAfterSec?: number;
}

function telegramErrorInfo(err: unknown): TelegramErrorInfo {
  const e = err as {
    message?: unknown;
    code?: unknown;
    response?: {
      statusCode?: unknown;
      body?: { description?: unknown; parameters?: { retry_after?: unknown } };
    };
  };
  const status = typeof e?.response?.statusCode === "number" ? e.response.statusCode : undefined;
  const description = [e?.response?.body?.description, e?.message]
    .filter((s): s is string => typeof s === "string")
    .join(" ");
  const retryRaw = e?.response?.body?.parameters?.retry_after;
  return {
    status,
    ...(typeof e?.code === "string" ? { code: e.code } : {}),
    description,
    ...(typeof retryRaw === "number" ? { retryAfterSec: retryRaw } : {}),
  };
}

/** Conservative "Telegram rejected the HTML entities" check: only a 400 (or an
 *  error without a status code at all) whose description matches Telegram's
 *  parse-rejection text warrants the plain-text resend. */
function isHtmlParseError(info: TelegramErrorInfo): boolean {
  if (info.status !== undefined && info.status !== 400) return false;
  return /can't parse entities/i.test(info.description);
}

/** Transient failures worth a durable retry: rate limits, server errors, and
 *  network-level failures. Everything else (403 blocked, 400 bad request…)
 *  would fail identically on retry. */
const RETRYABLE_CODES = new Set(["EFATAL", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"]);
function isRetryableSendError(info: TelegramErrorInfo): boolean {
  if (info.status === 429) return true;
  if (info.status !== undefined && info.status >= 500 && info.status < 600) return true;
  return info.code !== undefined && RETRYABLE_CODES.has(info.code);
}

export function startTelegramAdapter(opts: TelegramAdapterOptions): TelegramAdapterHandle {
  const { client, forumChatId } = opts;
  const userId = opts.userId ?? "local";
  const allowed = new Set((opts.allowedUsers ?? []).map((s) => s.trim()).filter(Boolean));
  const isAllowed = (telegramUserId: number | undefined): boolean =>
    allowed.size === 0 || allowed.has(String(telegramUserId));
  const titleFor = opts.topicTitleFor ?? defaultTopicTitle;
  const sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const typingHeartbeatMs = Math.max(250, opts.typingHeartbeatMs ?? 4_000);
  const footerEnabled = opts.footer === true;
  const dispatchTurn = opts.startTurn ?? startAiTurn;
  const store = openMappingStore(opts.mappingDbPath);
  const restoredForumChatId = store.loadForumChatId();
  const initialForumChatId = forumChatId ?? restoredForumChatId;
  let forumChat = initialForumChatId ?? 0;
  let forumMode = initialForumChatId !== undefined && typeof client.createForumTopic === "function";
  // A configured override is operator-authorized. A restored auto-connected
  // group is re-verified asynchronously before materializing new threads.
  let forumManageTopicsAvailable = forumMode && forumChatId !== undefined;
  if (forumChatId !== undefined) store.saveForumChatId(forumChatId);
  if (initialForumChatId !== undefined && !forumMode) {
    logger.warn(
      { forumChatId: initialForumChatId },
      "telegram adapter: forumChatId set but client lacks createForumTopic — forum mode disabled",
    );
  }
  const personalGeneral = ensurePersonalGeneral(userId);

  // ── mapping state ───────────────────────────────────────────────────
  // Two indexes over the same ChatMapping objects. byKey is 1:1 (a chat or
  // thread shows exactly one topic — UNIQUE(chat_id, thread_id) in the
  // store); byTopic fans out (a topic may render into several chats/threads,
  // e.g. a DM chat and a forum thread bound to the same room).
  const byKey = new Map<string, ChatMapping>(); // `${chatId}` | `${chatId}:${threadId}`
  const byTopic = new Map<string, Set<ChatMapping>>();
  const targetByQueryId = new Map<string, ChatMapping>();
  const typingHeartbeatByQueryId = new Map<string, ReturnType<typeof setInterval>>();
  const runtimeMessages = new Map<string, MessageDto>();
  const deliveredByRuntimeMessageId = new Map<string, DeliveredMessageRef[]>();
  const deletedRuntimeMessageIds = new Set<string>();
  const activeRuntimeDeliveries = new Map<string, number>();
  const completedRuntimeMessageCleanup = new Set<string>();
  const ownerDmChatIds = new Set<number>(
    [...allowed]
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
  let stopped = false;
  let botIdentity: Awaited<ReturnType<NonNullable<TelegramClientLike["getMe"]>>> | undefined;
  let botIdentityPromise: Promise<typeof botIdentity> | undefined;

  function beginRuntimeDelivery(messageId: string | undefined): void {
    if (!messageId) return;
    activeRuntimeDeliveries.set(messageId, (activeRuntimeDeliveries.get(messageId) ?? 0) + 1);
  }

  function endRuntimeDelivery(messageId: string | undefined): void {
    if (!messageId) return;
    const remaining = (activeRuntimeDeliveries.get(messageId) ?? 1) - 1;
    if (remaining > 0) activeRuntimeDeliveries.set(messageId, remaining);
    else {
      activeRuntimeDeliveries.delete(messageId);
      if (completedRuntimeMessageCleanup.delete(messageId)) {
        deletedRuntimeMessageIds.delete(messageId);
      }
    }
  }

  function typingTargets(topicId: string, queryId?: string): ChatMapping[] {
    const target = queryId ? targetByQueryId.get(queryId) : undefined;
    return target ? [target] : [...(byTopic.get(topicId) ?? [])];
  }

  function sendTyping(topicId: string, queryId?: string): void {
    if (typeof client.sendChatAction !== "function") return;
    for (const mapping of typingTargets(topicId, queryId)) {
      void client
        .sendChatAction(mapping.chatId, "typing", threadOpts(mapping.threadId))
        .catch(() => {});
    }
  }

  function stopTypingHeartbeat(queryId: string): void {
    const timer = typingHeartbeatByQueryId.get(queryId);
    if (!timer) return;
    clearInterval(timer);
    typingHeartbeatByQueryId.delete(queryId);
  }

  function startTypingHeartbeat(topicId: string, queryId: string): void {
    stopTypingHeartbeat(queryId);
    sendTyping(topicId, queryId);
    const timer = setInterval(() => {
      if (stopped) {
        stopTypingHeartbeat(queryId);
        return;
      }
      sendTyping(topicId, queryId);
    }, typingHeartbeatMs);
    timer.unref?.();
    typingHeartbeatByQueryId.set(queryId, timer);
  }

  function resolveBotIdentity(): Promise<typeof botIdentity> {
    if (botIdentity) return Promise.resolve(botIdentity);
    if (typeof client.getMe !== "function") return Promise.resolve(undefined);
    if (botIdentityPromise) return botIdentityPromise;
    botIdentityPromise = (async () => {
      let attempt = 0;
      while (!stopped) {
        try {
          botIdentity = await client.getMe!();
          return botIdentity;
        } catch (err) {
          attempt += 1;
          const waitMs = Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5));
          logger.warn(
            { err, attempt, waitMs },
            "telegram adapter: getMe failed while resolving onboarding identity; retrying",
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
      return undefined;
    })().finally(() => {
      botIdentityPromise = undefined;
    });
    return botIdentityPromise;
  }

  // Warm the identity cache so the common first-DM path has no added latency.
  void resolveBotIdentity();

  const mappingKey = (chatId: number, threadId?: number): string =>
    threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;

  const threadOpts = (threadId?: number): Record<string, unknown> =>
    threadId === undefined ? {} : { message_thread_id: threadId };

  /** Remove one mapping from the byTopic fan-out set (byKey untouched). */
  function detachFromTopic(mapping: ChatMapping): void {
    const set = byTopic.get(mapping.topicId);
    if (!set) return;
    set.delete(mapping);
    if (set.size === 0) byTopic.delete(mapping.topicId);
  }

  function bindMapping(
    chatId: number,
    threadId: number | undefined,
    topicId: string,
    { persist = true } = {},
  ): ChatMapping {
    const key = mappingKey(chatId, threadId);
    const prev = byKey.get(key);
    if (prev) {
      if (prev.topicId === topicId) return prev;
      // Re-bind (e.g. /new or /agent in an already-mapped chat/thread):
      // detach only THIS key from the old topic — its other bindings stay —
      // and log so the remap is never silent.
      detachFromTopic(prev);
      logger.info(
        { chatId, threadId, fromTopicId: prev.topicId, toTopicId: topicId },
        "telegram adapter: re-binding chat/thread to a new topic",
      );
    }
    const mapping: ChatMapping = {
      topicId,
      chatId,
      ...(threadId !== undefined ? { threadId } : {}),
    };
    byKey.set(key, mapping);
    let set = byTopic.get(topicId);
    if (!set) {
      set = new Set();
      byTopic.set(topicId, set);
    }
    set.add(mapping);
    if (persist) store.save({ chatId, threadId, topicId }); // upserts by (chat, thread)
    return mapping;
  }

  /** Drop every binding of a topic (topic deleted / vanished). */
  function unbindTopic(topicId: string): void {
    const set = byTopic.get(topicId);
    if (set) {
      for (const mapping of set) byKey.delete(mappingKey(mapping.chatId, mapping.threadId));
      byTopic.delete(topicId);
    }
    store.deleteByTopic(topicId);
  }

  function unloadMapping(chatId: number, threadId?: number): boolean {
    const key = mappingKey(chatId, threadId);
    const mapping = byKey.get(key);
    if (!mapping) return false;
    detachFromTopic(mapping);
    byKey.delete(key);
    store.deleteByChat(chatId, threadId);
    return true;
  }

  function loadExistingTopic(chatId: number, topicId: string, threadId?: number): boolean {
    const topic = getTopic(topicId);
    if (!topic?.participants.some((participant) => participant.userId === userId)) {
      return false;
    }
    bindMapping(chatId, threadId, topic.id);
    return true;
  }

  // Restore persisted routing so a restart keeps delivering into existing
  // chats/threads instead of materializing duplicates.
  for (const persisted of store.load()) {
    bindMapping(persisted.chatId, persisted.threadId, persisted.topicId, { persist: false });
  }

  // ── topic creation (adapter-initiated) ──────────────────────────────
  // registerTopic broadcasts `topic-created` SYNCHRONOUSLY on the in-process
  // bus, so the counter is guaranteed to still be >0 when the materializer's
  // subscriber runs — that synchronicity is the whole mechanism. If core ever
  // defers the broadcast (queue/microtask), this guard silently stops working
  // and adapter-created topics would double-materialize.
  // When the ADAPTER creates the topic (inbound auto-create, /new, /agent) it
  // binds its own mapping, so the forum-mode materializer must not race it
  // into a duplicate thread.
  let suppressMaterialize = 0;
  function registerTopicLocal(options: RegisterTopicOptions): TopicDto {
    suppressMaterialize++;
    try {
      return registerTopic(options);
    } finally {
      suppressMaterialize--;
    }
  }

  /** Reuse a topic by name if this node already has it, else create one. */
  function getOrCreateTopic(title: string, agent?: AgentKind): TopicDto {
    return (
      getTopicByNameForUser(title, userId) ??
      registerTopicLocal({ title, userId, kind: "agent", ...(agent ? { agent } : {}) })
    );
  }

  function resolveMapping(chatId: number, threadId?: number): TopicDto {
    const cached = byKey.get(mappingKey(chatId, threadId));
    if (cached) {
      const topic = getTopic(cached.topicId);
      if (topic) return topic;
      unbindTopic(cached.topicId); // topic vanished underneath the mapping
    }
    const topic = getOrCreateTopic(titleFor(chatId, threadId), opts.defaultAgent);
    bindMapping(chatId, threadId, topic.id);
    return topic;
  }

  // ── durable retry outbox ────────────────────────────────────────────
  // Simplified port of clawgram's telegram-outbox: transient send failures
  // (429/5xx/network) are persisted and re-tried with exponential backoff
  // (base→cap), max attempts then marked dead (row kept, never retried).
  const outboxCfg = {
    pollMs: opts.outbox?.pollMs ?? 500,
    baseDelayMs: opts.outbox?.baseDelayMs ?? 1_000,
    maxDelayMs: opts.outbox?.maxDelayMs ?? 60_000,
    maxAttempts: opts.outbox?.maxAttempts ?? 6,
  };
  let outboxTimer: ReturnType<typeof setTimeout> | undefined;
  let outboxFlushing = false;

  function scheduleOutboxFlush(): void {
    if (stopped || outboxTimer !== undefined) return;
    outboxTimer = setTimeout(() => {
      outboxTimer = undefined;
      void flushOutbox();
    }, outboxCfg.pollMs);
  }

  function outboxBackoffMs(attempts: number, info: TelegramErrorInfo): number {
    if (info.status === 429 && info.retryAfterSec !== undefined) {
      return Math.max(info.retryAfterSec * 1000, 0);
    }
    return Math.min(outboxCfg.baseDelayMs * 2 ** (attempts - 1), outboxCfg.maxDelayMs);
  }

  function enqueueOutbox(
    chatId: number,
    threadId: number | undefined,
    html: string,
    plain: string,
    info: TelegramErrorInfo,
    runtimeMessageId?: string,
    footer?: string,
  ): void {
    if (stopped) return;
    // A 429's retry_after is server truth — schedule the first retry there.
    const initialDelay =
      info.status === 429 && info.retryAfterSec !== undefined
        ? info.retryAfterSec * 1000
        : outboxCfg.baseDelayMs;
    store.outboxEnqueue({
      chatId,
      threadId,
      runtimeMessageId,
      footer,
      html,
      plain,
      nextTryAt: Date.now() + initialDelay,
      lastError: info.description || info.code || "send failed",
    });
    logger.warn(
      { chatId, threadId, status: info.status, code: info.code },
      "telegram adapter: transient send failure — queued for retry",
    );
    scheduleOutboxFlush();
  }

  async function flushOutbox(): Promise<void> {
    if (stopped || outboxFlushing) return;
    outboxFlushing = true;
    let entries: ReturnType<typeof store.outboxDue> = [];
    const releasedEntryIds = new Set<number>();
    const releaseEntry = (entry: (typeof entries)[number]): void => {
      if (releasedEntryIds.has(entry.id)) return;
      releasedEntryIds.add(entry.id);
      endRuntimeDelivery(entry.runtimeMessageId);
    };
    try {
      entries = store.outboxDue(Date.now());
      for (const entry of entries) beginRuntimeDelivery(entry.runtimeMessageId);
      for (const entry of entries) {
        if (stopped) return;
        if (entry.runtimeMessageId && deletedRuntimeMessageIds.has(entry.runtimeMessageId)) {
          store.outboxDelete(entry.id);
          releaseEntry(entry);
          continue;
        }
        let sendErr: unknown;
        let sent = false;
        let sentValue: unknown;
        let sentText = entry.html;
        let sentAsHtml = true;
        try {
          sentValue = await client.sendMessage(entry.chatId, entry.html, {
            ...threadOpts(entry.threadId),
            parse_mode: "HTML",
          });
          sent = true;
        } catch (err) {
          sendErr = err;
          if (isHtmlParseError(telegramErrorInfo(err))) {
            try {
              sentValue = await client.sendMessage(
                entry.chatId,
                entry.plain,
                threadOpts(entry.threadId),
              );
              sentText = entry.plain;
              sentAsHtml = false;
              sent = true;
            } catch (plainErr) {
              sendErr = plainErr;
            }
          }
        }
        if (stopped) {
          releaseEntry(entry);
          return; // store is (about to be) closed — leave the row for restart
        }
        if (sent) {
          store.outboxDelete(entry.id);
          const telegramMessageId = sentMessageId(sentValue);
          if (entry.runtimeMessageId && telegramMessageId !== null) {
            const ref: DeliveredMessageRef = {
              chatId: entry.chatId,
              threadId: entry.threadId,
              messageId: telegramMessageId,
              kind: "text",
              text: sentText,
              html: sentAsHtml,
              ...(entry.footer ? { footer: entry.footer } : {}),
            };
            if (deletedRuntimeMessageIds.has(entry.runtimeMessageId)) {
              await deleteDeliveredRefs(entry.runtimeMessageId, [ref]);
            } else {
              rememberDeliveredRefs(entry.runtimeMessageId, [ref]);
            }
          }
          releaseEntry(entry);
          continue;
        }
        const info = telegramErrorInfo(sendErr);
        const attempts = entry.attempts + 1;
        const error = info.description || info.code || "send failed";
        if (attempts >= outboxCfg.maxAttempts) {
          store.outboxMarkDead(entry.id, attempts, error);
          logger.warn(
            { id: entry.id, chatId: entry.chatId, attempts, error },
            "telegram adapter: outbox entry dead-lettered after max attempts",
          );
        } else {
          store.outboxReschedule(
            entry.id,
            attempts,
            Date.now() + outboxBackoffMs(attempts, info),
            error,
          );
        }
        releaseEntry(entry);
      }
    } catch (err) {
      // Post-stop db access or unexpected store failure must not crash the host.
      if (!stopped) logger.warn({ err }, "telegram adapter: outbox flush failed");
    } finally {
      for (const entry of entries) releaseEntry(entry);
      outboxFlushing = false;
      if (!stopped && store.outboxAll().some((e) => !e.dead)) scheduleOutboxFlush();
    }
  }

  // Restart durability: resume flushing anything queued by a previous run.
  if (store.outboxAll().some((e) => !e.dead)) scheduleOutboxFlush();

  // ── outbound delivery ───────────────────────────────────────────────
  /** Send one runtime message into a chat: HTML chunks, sequential awaits so
   *  multi-chunk messages arrive in order. Per-chunk error policy:
   *    - HTML parse rejection (400 "can't parse entities") → resend the chunk
   *      as plain text,
   *    - transient failure (429 honoring retry_after / 5xx / network) →
   *      enqueue into the durable retry outbox,
   *    - anything else → log and drop the chunk (don't misclassify e.g. a
   *      403 "bot was blocked" as a formatting problem).
   */
  function sentMessageId(value: unknown): number | null {
    if (!value || typeof value !== "object" || !("message_id" in value)) return null;
    const id = (value as { message_id?: unknown }).message_id;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
  }

  function rememberDeliveredRefs(messageId: string, refs: DeliveredMessageRef[]): void {
    if (refs.length === 0) return;
    const current = deliveredByRuntimeMessageId.get(messageId) ?? [];
    current.push(...refs);
    deliveredByRuntimeMessageId.set(messageId, current);
  }

  async function deleteDeliveredRefs(
    runtimeMessageId: string,
    refs: DeliveredMessageRef[],
    topicId?: string,
  ): Promise<void> {
    if (typeof client.deleteMessage !== "function") return;
    for (const ref of refs) {
      await client
        .deleteMessage(ref.chatId, ref.messageId)
        .catch((err) =>
          logger.warn(
            { err, topicId, messageId: runtimeMessageId, telegramMessageId: ref.messageId },
            "telegram adapter: superseded message cleanup failed",
          ),
        );
    }
  }

  function isDeliveredTextRef(
    ref: DeliveredMessageRef,
  ): ref is DeliveredMessageRef & { kind: "text"; text: string; html: boolean } {
    return ref.kind === "text" && typeof ref.text === "string" && typeof ref.html === "boolean";
  }

  async function deliver(
    chatId: number,
    threadId: number | undefined,
    text: string,
    runtimeMessageId?: string,
    footer?: string,
  ): Promise<DeliveredTextRef[]> {
    const base = threadOpts(threadId);
    const htmlOpts = { ...base, parse_mode: "HTML" };
    const delivered: DeliveredTextRef[] = [];
    const chunks = renderOutbound(text);
    for (const [index, chunk] of chunks.entries()) {
      const chunkFooter = footer && index === chunks.length - 1 ? footer : undefined;
      try {
        const sent = await client.sendMessage(chatId, chunk.html, htmlOpts);
        const messageId = sentMessageId(sent);
        if (messageId !== null) {
          delivered.push({
            messageId,
            kind: "text",
            text: chunk.html,
            html: true,
            ...(chunkFooter ? { footer: chunkFooter } : {}),
          });
        }
      } catch (err) {
        const info = telegramErrorInfo(err);
        if (isHtmlParseError(info)) {
          // Telegram rejected the HTML (e.g. markdown cut mid-chunk produced
          // invalid tags) — clawgram's fallback: resend the chunk as plain text.
          try {
            const sent = await client.sendMessage(chatId, chunk.plain, base);
            const messageId = sentMessageId(sent);
            if (messageId !== null) {
              delivered.push({
                messageId,
                kind: "text",
                text: chunk.plain,
                html: false,
                ...(chunkFooter ? { footer: chunkFooter } : {}),
              });
            }
          } catch (fallbackErr) {
            const fallbackInfo = telegramErrorInfo(fallbackErr);
            if (isRetryableSendError(fallbackInfo)) {
              enqueueOutbox(
                chatId,
                threadId,
                chunk.plain,
                chunk.plain,
                fallbackInfo,
                runtimeMessageId,
                chunkFooter,
              );
            } else {
              logger.warn({ err: fallbackErr, chatId }, "telegram adapter: plain fallback failed");
            }
          }
          continue;
        }
        if (isRetryableSendError(info)) {
          enqueueOutbox(
            chatId,
            threadId,
            chunk.html,
            chunk.plain,
            info,
            runtimeMessageId,
            chunkFooter,
          );
          continue;
        }
        logger.warn({ err, chatId }, "telegram adapter: send failed — dropping chunk");
      }
    }
    return delivered;
  }

  /** Send one produced file (from a [FILE:] tag): photos by extension via
   *  sendPhoto, everything else via sendDocument; sensitive paths blocked;
   *  missing files surface as a plain-text notice (model intent was explicit). */
  async function sendFile(
    chatId: number,
    threadId: number | undefined,
    path: string,
  ): Promise<DeliveredMediaRef | null> {
    const base = threadOpts(threadId);
    if (isSensitivePath(path)) {
      logger.warn({ path, chatId }, "telegram adapter: blocked sensitive file path");
      return null;
    }
    if (!existsSync(path)) {
      const sent = await client.sendMessage(chatId, `File: ${path}`, base).catch(() => null);
      const messageId = sentMessageId(sent);
      return messageId === null ? null : { messageId, kind: "media" };
    }
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    try {
      let sent: unknown;
      if (PHOTO_EXTS.has(ext) && typeof client.sendPhoto === "function") {
        sent = await client.sendPhoto(chatId, path, base);
      } else if (typeof client.sendDocument === "function") {
        sent = await client.sendDocument(chatId, path, base);
      } else {
        // Client has no file surface — at least point the user at the path.
        sent = await client.sendMessage(chatId, `File: ${path}`, base);
      }
      const messageId = sentMessageId(sent);
      return messageId === null ? null : { messageId, kind: "media" };
    } catch (err) {
      logger.warn({ err, path, chatId }, "telegram adapter: file send failed");
      return null;
    }
  }

  async function deliverPayload(
    chatId: number,
    threadId: number | undefined,
    payload: OutboundPayload,
  ): Promise<void> {
    if (payload.runtimeMessageId && deletedRuntimeMessageIds.has(payload.runtimeMessageId)) return;
    beginRuntimeDelivery(payload.runtimeMessageId);
    const deliveredRefs: DeliveredMessageRef[] = [];
    try {
      let text = payload.text;
      let footer: string | null = null;
      if (payload.runtimeMessageId && footerEnabled) {
        const message = runtimeMessages.get(payload.runtimeMessageId);
        // Query-scoped segments before tools are not final replies. Their usage
        // patch (or the final text segment's usage) identifies the one message
        // that should carry the turn footer.
        const shouldRenderFooter = message && (!message.queryId || message.usage);
        footer = shouldRenderFooter ? renderTurnFooter(message) : null;
        if (footer) {
          text = text ? `${text}\n\n*${footer}*` : `*${footer}*`;
        }
      }
      if (text) {
        const delivered = await deliver(
          chatId,
          threadId,
          text,
          payload.runtimeMessageId,
          footer ?? undefined,
        );
        deliveredRefs.push(
          ...delivered.map((item) => ({
            ...item,
            chatId,
            threadId,
          })),
        );
      }
      for (const path of payload.files) {
        if (payload.runtimeMessageId && deletedRuntimeMessageIds.has(payload.runtimeMessageId)) {
          break;
        }
        const delivered = await sendFile(chatId, threadId, path);
        if (delivered) deliveredRefs.push({ ...delivered, chatId, threadId });
      }
      if (payload.runtimeMessageId && deliveredRefs.length > 0) {
        if (deletedRuntimeMessageIds.has(payload.runtimeMessageId)) {
          await deleteDeliveredRefs(payload.runtimeMessageId, deliveredRefs);
        } else {
          rememberDeliveredRefs(payload.runtimeMessageId, deliveredRefs);
        }
      }
    } finally {
      endRuntimeDelivery(payload.runtimeMessageId);
    }
  }

  // Per-topic send chains keep messages ordered even when materialization
  // flushes a buffer while new bus events keep arriving. Each link is capped
  // by a watchdog so one hung sendMessage can't wedge the topic forever, and
  // a drained chain removes its map entry so long-lived processes don't
  // accumulate one settled promise per topic ever spoken to.
  const sendQueues = new Map<string, Promise<void>>();
  function enqueueSend(topicId: string, task: () => Promise<void>): void {
    const prev = sendQueues.get(topicId) ?? Promise.resolve();
    const next = prev.then(
      () =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn(
              { topicId, sendTimeoutMs },
              "telegram adapter: send timed out — abandoning it and continuing the queue",
            );
            resolve();
          }, sendTimeoutMs);
          task()
            .catch((err) => logger.warn({ err, topicId }, "telegram adapter: send task failed"))
            .finally(() => {
              clearTimeout(timer);
              resolve();
            });
        }),
    );
    sendQueues.set(topicId, next);
    void next.then(() => {
      // Chain-end cleanup: only the tail may delete the entry (a newer link
      // may already have replaced `next`).
      if (sendQueues.get(topicId) === next) sendQueues.delete(topicId);
    });
  }

  /** Deliver into every chat/thread currently bound to the topic, in order. */
  function enqueueFanout(
    topicId: string,
    mappings: Iterable<ChatMapping>,
    payload: OutboundPayload,
  ): void {
    const targets = [...mappings];
    enqueueSend(topicId, async () => {
      for (const m of targets) await deliverPayload(m.chatId, m.threadId, payload);
    });
  }

  function enqueueTarget(topicId: string, target: ChatMapping, payload: OutboundPayload): void {
    enqueueSend(topicId, () => deliverPayload(target.chatId, target.threadId, payload));
  }

  // ── forum mode: materialize runtime topics as forum threads ─────────
  /** One in-flight `createForumTopic`: messages arriving meanwhile are
   *  buffered (flushed in order once the thread exists); `cancelled` is set
   *  by topic-deleted so the continuation discards the orphan thread. */
  interface PendingMaterialization {
    buffer: OutboundPayload[];
    cancelled: boolean;
  }
  const pendingByTopic = new Map<string, PendingMaterialization>();
  /** Topics waiting for the bot's Manage Topics permission. Unlike permanent
   *  tombstones, these are retried when Telegram reports the permission was
   *  granted. */
  const permissionBlockedTopics = new Map<string, string>();
  /** topicId → title for topics whose thread creation failed: subsequent
   *  messages go to the general chat with a `[title]` prefix instead of
   *  re-attempting creation on every message. Persisted so restarts keep the
   *  fallback instead of dropping messages or re-failing creation. */
  const materializeTombstones = new Map<string, string>();
  if (forumMode) {
    for (const t of store.loadTombstones()) materializeTombstones.set(t.topicId, t.title);
  }

  function deliverFallback(title: string, payload: OutboundPayload): Promise<void> {
    return deliverPayload(forumChat, undefined, {
      text: payload.text ? `[${title}] ${payload.text}` : "",
      files: payload.files,
      runtimeMessageId: payload.runtimeMessageId,
    });
  }

  function flushBuffered(
    topicId: string,
    buffer: OutboundPayload[],
    send: (payload: OutboundPayload) => Promise<void>,
  ): void {
    for (const payload of buffer) enqueueSend(topicId, () => send(payload));
  }

  function materializeTopic(topic: TopicDto): void {
    if (
      !forumManageTopicsAvailable ||
      suppressMaterialize > 0 ||
      byTopic.has(topic.id) ||
      pendingByTopic.has(topic.id) ||
      permissionBlockedTopics.has(topic.id) ||
      materializeTombstones.has(topic.id)
    ) {
      return;
    }
    if (!isTopicVisible(topic)) return;
    // Only rooms the adapter's (single) negotium user can see.
    if (!topic.participants?.some((p) => p.userId === userId)) return;
    const materializationChat = forumChat;
    const pending: PendingMaterialization = { buffer: [], cancelled: false };
    pendingByTopic.set(topic.id, pending);
    void (async () => {
      let created: { message_thread_id: number };
      try {
        // forumMode implies createForumTopic exists (checked at start).
        created = await client.createForumTopic!(
          materializationChat,
          topic.title.slice(0, FORUM_TOPIC_NAME_MAX),
        );
      } catch (err) {
        if (pendingByTopic.get(topic.id) === pending) pendingByTopic.delete(topic.id);
        // Adapter stopped or topic deleted while the call was in flight —
        // not a creation failure; don't tombstone (store may be closed).
        if (stopped || pending.cancelled) return;
        const errorInfo = telegramErrorInfo(err);
        if (isManageTopicsPermissionError(errorInfo)) {
          const permissionWasAvailable = forumManageTopicsAvailable;
          forumManageTopicsAvailable = false;
          permissionBlockedTopics.set(topic.id, topic.title);
          logger.warn(
            { err, topicId: topic.id, title: topic.title },
            "telegram adapter: Manage Topics unavailable — waiting for permission recovery",
          );
          if (permissionWasAvailable) {
            reply(
              forumChat,
              undefined,
              'Forum topic creation is paused. Enable the bot administrator permission "Manage Topics"; pending topics will be retried automatically.',
            );
          }
          flushBuffered(topic.id, pending.buffer, (payload) =>
            deliverFallback(topic.title, payload),
          );
          return;
        }
        logger.warn(
          { err, topicId: topic.id, title: topic.title },
          "telegram adapter: createForumTopic failed permanently — falling back to general chat",
        );
        materializeTombstones.set(topic.id, topic.title);
        store.saveTombstone(topic.id, topic.title);
        flushBuffered(topic.id, pending.buffer, (payload) => deliverFallback(topic.title, payload));
        return;
      }
      if (pendingByTopic.get(topic.id) === pending) pendingByTopic.delete(topic.id);
      const threadId = created.message_thread_id;
      if (stopped || pending.cancelled) {
        // Cancelled = the topic was deleted while creation was in flight:
        // drop the just-created orphan thread (best-effort) and bind nothing.
        // Stopped = abandon silently (no post-stop sends, no closed-DB save).
        if (pending.cancelled && typeof client.deleteForumTopic === "function") {
          void client
            .deleteForumTopic(materializationChat, threadId)
            .catch((err) =>
              logger.warn(
                { err, topicId: topic.id, threadId },
                "telegram adapter: orphan thread cleanup failed",
              ),
            );
        }
        return;
      }
      bindMapping(materializationChat, threadId, topic.id);
      flushBuffered(topic.id, pending.buffer, (payload) =>
        deliverPayload(materializationChat, threadId, payload),
      );
    })();
  }

  function handleTopicDeleted(topicId: string): void {
    if (materializeTombstones.delete(topicId)) store.deleteTombstone(topicId);
    const pending = pendingByTopic.get(topicId);
    if (pending) pending.cancelled = true; // in-flight creation — its continuation cleans up
    for (const [messageId, message] of runtimeMessages) {
      if (message.topicId === topicId) deleteDeliveredRuntimeMessage(topicId, messageId);
    }
    const set = byTopic.get(topicId);
    if (!set) return;
    const mappings = [...set];
    unbindTopic(topicId);
    for (const mapping of mappings) {
      if (
        forumMode &&
        mapping.chatId === forumChat &&
        mapping.threadId !== undefined &&
        typeof client.deleteForumTopic === "function"
      ) {
        void client
          .deleteForumTopic(mapping.chatId, mapping.threadId)
          .catch((err) =>
            logger.warn(
              { err, topicId, threadId: mapping.threadId },
              "telegram adapter: deleteForumTopic failed",
            ),
          );
      }
    }
  }

  // ── outbound message routing ────────────────────────────────────────
  /** DM fallback target: nearest mapped ancestor up the parentTopicId chain
   *  (bounded hops + cycle guard — parent links come from storage). */
  function findMappedAncestor(topic: TopicDto): Set<ChatMapping> | undefined {
    const seen = new Set<string>([topic.id]);
    let current: TopicDto | null = topic;
    for (let hop = 0; hop < MAX_PARENT_HOPS && current; hop++) {
      const parentId = current.parentTopicId;
      if (!parentId || seen.has(parentId)) return undefined;
      seen.add(parentId);
      const mappings = byTopic.get(parentId);
      if (mappings && mappings.size > 0) return mappings;
      current = getTopic(parentId);
    }
    return undefined;
  }

  function routeMessage(topicId: string, payload: OutboundPayload, queryId?: string): void {
    const pending = pendingByTopic.get(topicId);
    if (pending) {
      pending.buffer.push(payload); // thread creation in flight — flushed in order later
      return;
    }
    const specificTarget = queryId ? targetByQueryId.get(queryId) : undefined;
    if (specificTarget) {
      enqueueTarget(topicId, specificTarget, payload);
      return;
    }
    const mappings = byTopic.get(topicId);
    if (mappings && mappings.size > 0) {
      // A Telegram-owned query has a specific target above. Events produced by
      // Terminal or another surface intentionally fan out to every mapped
      // personal General so the owner's channel views stay synchronized.
      enqueueFanout(topicId, mappings, payload);
      return;
    }
    const tombstoneTitle = materializeTombstones.get(topicId);
    if (tombstoneTitle !== undefined) {
      enqueueSend(topicId, () => deliverFallback(tombstoneTitle, payload));
      return;
    }
    const topic = getTopic(topicId);
    if (!topic) return;
    if (forumMode) {
      if (!forumManageTopicsAvailable || permissionBlockedTopics.has(topicId)) {
        enqueueSend(topicId, () => deliverFallback(topic.title, payload));
        return;
      }
      // Lazy materialization: first message for a live topic with no binding
      // (topic predates the adapter, missed topic-created, dropped binding…)
      // — create its thread now instead of silently discarding the message.
      // Same suppress/participant rules as the topic-created path.
      materializeTopic(topic);
      pendingByTopic.get(topicId)?.buffer.push(payload);
      return;
    }
    // DM fallback: a child room (spawn_subagent, fork) descending from a
    // mapped chat topic forwards into that chat with a `[title]` prefix so
    // subagent output stays visible without forum mode.
    const ancestorMappings = findMappedAncestor(topic);
    if (ancestorMappings) {
      enqueueFanout(topicId, ancestorMappings, {
        text: payload.text ? `[${topic.title}] ${payload.text}` : "",
        files: payload.files,
        runtimeMessageId: payload.runtimeMessageId,
      });
    }
  }

  function deleteDeliveredRuntimeMessage(topicId: string, messageId: string): void {
    deletedRuntimeMessageIds.add(messageId);
    completedRuntimeMessageCleanup.delete(messageId);
    runtimeMessages.delete(messageId);
    const pending = pendingByTopic.get(topicId);
    if (pending) {
      pending.buffer = pending.buffer.filter((payload) => payload.runtimeMessageId !== messageId);
    }
    store.outboxDeleteByRuntimeMessageId(messageId);
    enqueueSend(topicId, async () => {
      const refs = deliveredByRuntimeMessageId.get(messageId) ?? [];
      deliveredByRuntimeMessageId.delete(messageId);
      await deleteDeliveredRefs(messageId, refs, topicId);
      if ((activeRuntimeDeliveries.get(messageId) ?? 0) > 0) {
        completedRuntimeMessageCleanup.add(messageId);
      } else {
        completedRuntimeMessageCleanup.delete(messageId);
        deletedRuntimeMessageIds.delete(messageId);
      }
    });
  }

  function attachUpdatedFooter(topicId: string, messageId: string, footer: string): void {
    enqueueSend(topicId, async () => {
      if (deletedRuntimeMessageIds.has(messageId)) return;
      const refs = deliveredByRuntimeMessageId.get(messageId) ?? [];
      type StoredTextRef = DeliveredMessageRef & {
        kind: "text";
        text: string;
        html: boolean;
      };
      const refsByTarget = new Map<string, StoredTextRef[]>();
      for (const ref of refs) {
        if (!isDeliveredTextRef(ref)) continue;
        const key = `${ref.chatId}:${ref.threadId ?? "root"}`;
        const targetRefs = refsByTarget.get(key) ?? [];
        targetRefs.push(ref);
        refsByTarget.set(key, targetRefs);
      }
      const footerChunk = renderOutbound(`*${footer}*`)[0];
      if (!footerChunk) return;
      for (const targetRefs of refsByTarget.values()) {
        const ref =
          targetRefs.findLast((candidate) => candidate.footer !== undefined) ?? targetRefs.at(-1);
        if (!ref) continue;
        if (ref.footer === footer) continue;
        if (typeof client.editMessageText === "function") {
          const suffix = ref.html ? footerChunk.html : footerChunk.plain;
          const previousFooterChunk = ref.footer ? renderOutbound(`*${ref.footer}*`)[0] : undefined;
          const previousSuffix = previousFooterChunk
            ? ref.html
              ? previousFooterChunk.html
              : previousFooterChunk.plain
            : "";
          const previousTrailer = previousSuffix ? `\n\n${previousSuffix}` : "";
          const baseText =
            previousTrailer && ref.text.endsWith(previousTrailer)
              ? ref.text.slice(0, -previousTrailer.length)
              : ref.text;
          const text = `${baseText}\n\n${suffix}`;
          const editOptions = {
            chat_id: ref.chatId,
            message_id: ref.messageId,
            ...(ref.html ? { parse_mode: "HTML" } : {}),
          };
          try {
            await client.editMessageText(text, editOptions);
            ref.text = text;
            ref.footer = footer;
            continue;
          } catch (err) {
            let editError = err;
            const info = telegramErrorInfo(err);
            if (isRetryableSendError(info)) {
              const retryDelayMs = Math.max(0, (info.retryAfterSec ?? 0) * 1000);
              // Keep this topic's queue bounded. For a long rate limit, leave
              // the existing message untouched rather than risk a duplicate
              // footer from an ambiguous edit result.
              if (retryDelayMs > 30_000) {
                logger.warn(
                  { err, topicId, messageId, retryDelayMs },
                  "telegram adapter: footer edit rate-limited; leaving footer unchanged",
                );
                continue;
              }
              if (retryDelayMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
              }
              try {
                await client.editMessageText(text, editOptions);
                ref.text = text;
                ref.footer = footer;
                continue;
              } catch (retryErr) {
                if (isRetryableSendError(telegramErrorInfo(retryErr))) {
                  logger.warn(
                    { err: retryErr, topicId, messageId, telegramMessageId: ref.messageId },
                    "telegram adapter: footer edit retry failed; leaving footer unchanged",
                  );
                  continue;
                }
                editError = retryErr;
              }
            }
            logger.warn(
              { err: editError, topicId, messageId, telegramMessageId: ref.messageId },
              "telegram adapter: footer edit failed permanently; sending footer separately",
            );
          }
        }
        const delivered = await deliver(ref.chatId, ref.threadId, `*${footer}*`, messageId, footer);
        refs.push(
          ...delivered.map((item) => ({
            ...item,
            chatId: ref.chatId,
            threadId: ref.threadId,
            footer,
          })),
        );
      }
      deliveredByRuntimeMessageId.set(messageId, refs);
    });
  }

  function clearQueryDeliveryState(queryId: string): void {
    const timer = setTimeout(() => {
      for (const [messageId, message] of runtimeMessages) {
        if (message.queryId !== queryId) continue;
        runtimeMessages.delete(messageId);
        deliveredByRuntimeMessageId.delete(messageId);
        deletedRuntimeMessageIds.delete(messageId);
      }
    }, 5 * 60_000);
    timer.unref?.();
  }

  // ── inbound: Telegram → runtime ─────────────────────────────────────
  /** Fire-and-forget plain-text reply (command feedback, error notices). */
  function reply(chatId: number, threadId: number | undefined, text: string): void {
    void client
      .sendMessage(chatId, text, threadOpts(threadId))
      .catch((err) => logger.warn({ err, chatId }, "telegram adapter: reply failed"));
  }

  async function sendOnboardingGuide(chatId: number, threadId?: number): Promise<void> {
    const bot = await resolveBotIdentity();
    if (stopped) return;
    await client
      .sendMessage(chatId, onboardingGuide(bot?.username), threadOpts(threadId))
      .catch((err) => logger.warn({ err, chatId }, "telegram adapter: onboarding guide failed"));
  }

  function materializeVisibleTopics(): void {
    if (!forumMode || !forumManageTopicsAvailable) return;
    for (const topic of listTopics()) {
      if (
        isTopicVisible(topic) &&
        topic.participants.some((participant) => participant.userId === userId)
      ) {
        materializeTopic(topic);
      }
    }
  }

  function restoreForumTopicCreation({ retryPermanent = false } = {}): void {
    forumManageTopicsAvailable = true;
    permissionBlockedTopics.clear();
    if (retryPermanent) {
      materializeTombstones.clear();
      store.clearTombstones();
    }
    materializeVisibleTopics();
  }

  async function notifyOwnerDms(text: string): Promise<void> {
    await Promise.allSettled([...ownerDmChatIds].map((chatId) => client.sendMessage(chatId, text)));
  }

  async function disconnectForum(chatId: number): Promise<boolean> {
    if (!forumMode || forumChat !== chatId) return false;

    for (const [topicId, pending] of pendingByTopic) {
      pending.cancelled = true;
      if (pendingByTopic.get(topicId) === pending) pendingByTopic.delete(topicId);
    }
    for (const mapping of [...byKey.values()]) {
      if (mapping.chatId === chatId) unloadMapping(mapping.chatId, mapping.threadId);
    }
    for (const [queryId, target] of targetByQueryId) {
      if (target.chatId === chatId) targetByQueryId.delete(queryId);
    }

    permissionBlockedTopics.clear();
    materializeTombstones.clear();
    store.clearTombstones();
    store.outboxDeleteByChat(chatId);
    store.clearForumChatId();
    forumMode = false;
    forumManageTopicsAvailable = false;
    forumChat = 0;

    await notifyOwnerDms(
      "The Telegram forum was disconnected because the bot left or was removed. Your Negotium topics were preserved; promote the bot in a forum group to reconnect.",
    );
    logger.info({ userId, forumChatId: chatId }, "telegram adapter: forum disconnected");
    return true;
  }

  async function linkForumAndAnnounce(
    ownerTelegramId: number,
    chat: { id: number; title?: string },
    botMember: TelegramChatMember,
  ): Promise<boolean> {
    if (typeof client.createForumTopic !== "function") {
      reply(
        ownerTelegramId,
        undefined,
        "This Telegram client cannot create forum topics, so the group was not connected.",
      );
      return false;
    }
    if (forumMode && forumChat !== chat.id) {
      reply(
        ownerTelegramId,
        undefined,
        `A different forum group (${forumChat}) is already connected to this Negotium node.`,
      );
      return false;
    }
    const hasManageTopics = canManageTopics(botMember);
    if (forumMode && forumChat === chat.id) {
      const recovered = hasManageTopics && !forumManageTopicsAvailable;
      const lostPermission = !hasManageTopics && forumManageTopicsAvailable;
      if (hasManageTopics) {
        restoreForumTopicCreation({ retryPermanent: recovered });
        if (recovered) {
          await Promise.allSettled([
            client.sendMessage(
              chat.id,
              "Manage Topics permission confirmed. Pending Negotium topics are being created now.",
            ),
            notifyOwnerDms(
              `Manage Topics permission confirmed for “${chat.title?.trim() || chat.id}”. Pending topics are being retried.`,
            ),
          ]);
        }
      } else {
        forumManageTopicsAvailable = false;
        if (lostPermission) {
          await notifyOwnerDms(
            `Manage Topics permission was removed from “${chat.title?.trim() || chat.id}”. Existing topics are preserved; restore the permission to resume topic creation.`,
          );
        }
      }
      return true;
    }

    forumChat = chat.id;
    forumMode = true;
    forumManageTopicsAvailable = hasManageTopics;
    permissionBlockedTopics.clear();
    materializeTombstones.clear();
    store.clearTombstones();
    store.saveForumChatId(chat.id);
    bindMapping(chat.id, undefined, personalGeneral.id);
    ownerDmChatIds.add(ownerTelegramId);

    // Existing agent rooms become forum topics just like rooms created after
    // connection. General is already mapped above and therefore skipped.
    materializeVisibleTopics();

    const title = chat.title?.trim() || String(chat.id);
    const permissionWarning = hasManageTopics
      ? ""
      : '\n\nWarning: enable the bot administrator permission "Manage Topics" before creating or deleting topics.';
    await Promise.allSettled([
      client.sendMessage(
        chat.id,
        `Negotium connected to “${title}”. Use this General topic to create and manage topics in natural language.${permissionWarning}`,
      ),
      client.sendMessage(
        ownerTelegramId,
        `Connected forum group “${title}” (${chat.id}). No /connect command is needed.${permissionWarning}`,
      ),
    ]);
    logger.info(
      {
        userId,
        ownerTelegramId,
        forumChatId: chat.id,
        canManageTopics: hasManageTopics,
      },
      "telegram adapter: auto-connected forum group",
    );
    return true;
  }

  async function tryAutoConnectFromMessage(msg: TelegramIncomingMessage): Promise<boolean> {
    const senderId = msg.from?.id;
    if (
      msg.chat.type !== "supergroup" ||
      !msg.chat.is_forum ||
      senderId === undefined ||
      !isAllowed(senderId)
    ) {
      return false;
    }
    if (forumMode && msg.chat.id !== forumChat) return false;
    if (forumMode && forumManageTopicsAvailable) return true;
    if (typeof client.getMe !== "function" || typeof client.getChatMember !== "function") {
      return false;
    }

    try {
      const bot = await resolveBotIdentity();
      if (!bot) return false;
      const [botMember, senderMember] = await Promise.all([
        client.getChatMember(msg.chat.id, bot.id),
        client.getChatMember(msg.chat.id, senderId),
      ]);
      if (!isChatAdmin(botMember) || !isChatAdmin(senderMember)) return false;
      await linkForumAndAnnounce(senderId, msg.chat, botMember);
      return forumMode && forumChat === msg.chat.id;
    } catch (err) {
      logger.debug(
        { err, groupId: msg.chat.id, senderId },
        "telegram adapter: lazy forum auto-connect check failed",
      );
      return false;
    }
  }

  async function verifyInitialForumPermissions(): Promise<void> {
    if (!forumMode) return;
    if (forumChatId !== undefined) return;
    if (typeof client.getMe !== "function" || typeof client.getChatMember !== "function") {
      // Embedded legacy clients cannot expose membership state. Preserve the
      // previous configured-forum behavior instead of disabling the adapter.
      forumManageTopicsAvailable = true;
      return;
    }
    try {
      const bot = await resolveBotIdentity();
      if (!bot || stopped || !forumMode) return;
      const member = await client.getChatMember(forumChat, bot.id);
      if (member.status === "left" || member.status === "kicked") {
        await disconnectForum(forumChat);
        return;
      }
      if (canManageTopics(member)) {
        const restoredAutoConnection =
          forumChatId === undefined && restoredForumChatId !== undefined;
        restoreForumTopicCreation({ retryPermanent: restoredAutoConnection });
      } else {
        forumManageTopicsAvailable = false;
      }
    } catch (err) {
      logger.warn(
        { err, forumChatId: forumChat },
        "telegram adapter: initial forum permission check failed",
      );
    }
  }

  void verifyInitialForumPermissions();

  /** Persist the user message and start the AI turn (single fixed userId). */
  function runTurn(
    topic: TopicDto,
    prompt: string,
    chatId: number,
    threadId: number | undefined,
  ): void {
    const target: ChatMapping = {
      topicId: topic.id,
      chatId,
      ...(threadId !== undefined ? { threadId } : {}),
    };
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: userId,
      text: prompt,
      createdAt: new Date().toISOString(),
    });
    const rememberTarget = (queryId: string): void => {
      targetByQueryId.set(queryId, target);
    };
    const queryId = dispatchTurn({
      topic,
      userId,
      prompt,
      allowAutoContinue: true,
      onDispatched: rememberTarget,
    });
    if (queryId) rememberTarget(queryId);
  }

  // Preserve Telegram arrival order per chat/thread even when attachment
  // downloads or album debounce complete later than a following text message.
  const inboundQueues = new Map<string, Promise<void>>();
  function enqueueInbound(
    chatId: number,
    threadId: number | undefined,
    task: () => Promise<void> | void,
  ): void {
    const key = mappingKey(chatId, threadId);
    const previous = inboundQueues.get(key);
    const run = async (): Promise<void> => {
      if (stopped) return;
      await task();
    };
    // Keep the first task's synchronous prefix synchronous (topic creation,
    // mapping and plain-text persistence historically happened before the
    // Telegram callback returned). Only later arrivals need a promise hop.
    const next = (previous ? previous.catch(() => {}).then(run) : run()).catch((err) =>
      logger.warn({ err, chatId, threadId }, "telegram adapter: inbound task failed"),
    );
    inboundQueues.set(key, next);
    void next.then(() => {
      if (inboundQueues.get(key) === next) inboundQueues.delete(key);
    });
  }

  // ── inbound attachments ─────────────────────────────────────────────
  const transcriber = opts.transcribe ?? ((filePath: string) => transcribeAudio(filePath));
  const transcriptionAvailable = (): boolean =>
    opts.transcribe !== undefined || isTranscriptionConfigured();

  /** Download a Telegram file into the topic workspace via core's intake. */
  async function downloadToTopic(
    topicId: string,
    fileId: string,
    filename: string,
  ): Promise<IngestedAttachment> {
    // getFileLink presence is checked by the caller.
    const url = await client.getFileLink!(fileId);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`attachment download failed: HTTP ${res.status}`);
    return ingestAttachment({
      topicId,
      filename,
      bytes: new Uint8Array(await res.arrayBuffer()),
    });
  }

  /** Ingest one message's photo/document into the topic workspace and return
   *  the canonical prompt lines (shared by single-media and album paths). */
  async function ingestMessageFiles(
    topicId: string,
    msg: TelegramIncomingMessage,
  ): Promise<string[]> {
    const lines: string[] = [];
    if (msg.photo && msg.photo.length > 0) {
      // Highest-resolution variant is last (Telegram API contract).
      const photo = msg.photo[msg.photo.length - 1]!;
      lines.push((await downloadToTopic(topicId, photo.file_id, "photo.jpg")).promptLine);
    }
    if (msg.document) {
      const filename = msg.document.file_name || "file";
      lines.push((await downloadToTopic(topicId, msg.document.file_id, filename)).promptLine);
    }
    return lines;
  }

  /** Media message → download attachments → core prompt convention → turn.
   *  Mirrors clawgram's buildPromptFromMessage, minus PII/video. */
  async function handleMediaMessage(
    msg: TelegramIncomingMessage,
    chatId: number,
    threadId: number | undefined,
  ): Promise<void> {
    const caption = (msg.text ?? msg.caption ?? "").trim();
    const topic = resolveMapping(chatId, threadId);

    if (typeof client.getFileLink !== "function") {
      logger.warn(
        { chatId },
        "telegram adapter: media message but client lacks getFileLink — caption only",
      );
      if (caption) runTurn(topic, caption, chatId, threadId);
      else reply(chatId, threadId, "this bot cannot download attachments");
      return;
    }

    let promptLines: string[] = [];
    let voiceText = "";
    try {
      promptLines = await ingestMessageFiles(topic.id, msg);
      if (msg.voice) {
        if (!transcriptionAvailable()) {
          reply(
            chatId,
            threadId,
            "voice transcription is not configured on this bot — please send text",
          );
        } else {
          const ingested = await downloadToTopic(topic.id, msg.voice.file_id, "voice.ogg");
          const transcript = (await transcriber(ingested.path))?.trim();
          if (transcript) {
            voiceText = `[Voice transcript]\n${transcript}`;
          } else {
            reply(chatId, threadId, "voice transcription failed — please send text");
          }
        }
      }
    } catch (err) {
      logger.warn({ err, chatId, topicId: topic.id }, "telegram adapter: attachment intake failed");
      reply(chatId, threadId, errMsg(err, "attachment download failed"));
    }
    if (stopped) return;

    const userText = voiceText ? (caption ? `${voiceText}\n\n${caption}` : voiceText) : caption;
    if (!userText && promptLines.length === 0) return;
    runTurn(topic, composeAttachmentPrompt(userText, promptLines), chatId, threadId);
  }

  // ── media groups (albums) ───────────────────────────────────────────
  // Telegram splits a multi-photo upload into separate messages sharing one
  // `media_group_id`, arriving over ~1s. Without buffering each item would
  // start its own turn and abort-on-new-message would keep only the last.
  // Clawgram's bufferMediaGroup semantics: buffer per (chatId, groupId), a
  // debounce timer resets on every new item, then ONE flush combines every
  // caption + attachment into a single turn. On top of clawgram we add a
  // hard cap (maxWaitMs) so a trickling group can't defer its turn forever.
  const mediaGroupCfg = {
    debounceMs: opts.mediaGroup?.debounceMs ?? 1_000,
    maxWaitMs: opts.mediaGroup?.maxWaitMs ?? 3_000,
  };
  interface MediaGroupEntry {
    messages: TelegramIncomingMessage[];
    chatId: number;
    threadId?: number;
    firstSeenAt: number;
    timer: ReturnType<typeof setTimeout>;
    ready: Promise<void>;
    release: () => void;
  }
  const mediaGroups = new Map<string, MediaGroupEntry>(); // `${chatId}:${media_group_id}`

  function flushMediaGroup(key: string): void {
    const entry = mediaGroups.get(key);
    if (!entry) return;
    mediaGroups.delete(key);
    entry.release();
  }

  function bufferMediaGroup(
    msg: TelegramIncomingMessage,
    chatId: number,
    threadId: number | undefined,
  ): void {
    const key = `${chatId}:${msg.media_group_id}`;
    const existing = mediaGroups.get(key);
    if (existing) {
      existing.messages.push(msg);
      clearTimeout(existing.timer);
      // Debounce resets per item, but never beyond the cap from first sight.
      const remaining = existing.firstSeenAt + mediaGroupCfg.maxWaitMs - Date.now();
      const wait = Math.max(0, Math.min(mediaGroupCfg.debounceMs, remaining));
      existing.timer = setTimeout(() => flushMediaGroup(key), wait);
      return;
    }
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const entry: MediaGroupEntry = {
      messages: [msg],
      chatId,
      ...(threadId !== undefined ? { threadId } : {}),
      firstSeenAt: Date.now(),
      timer: setTimeout(
        () => flushMediaGroup(key),
        Math.min(mediaGroupCfg.debounceMs, mediaGroupCfg.maxWaitMs),
      ),
      ready,
      release: releaseReady,
    };
    mediaGroups.set(key, entry);
    // Reserve the first album item's arrival position. Later items can still
    // extend the buffer while this queue entry waits for the debounce signal.
    enqueueInbound(chatId, threadId, async () => {
      await entry.ready;
      if (stopped) return;
      await handleMediaGroupFlush(entry);
    });
  }

  /** One combined turn for a whole album: every caption + every attachment. */
  async function handleMediaGroupFlush(entry: MediaGroupEntry): Promise<void> {
    const { messages, chatId, threadId } = entry;
    const topic = resolveMapping(chatId, threadId);
    const captions = messages
      .map((m) => (m.text ?? m.caption ?? "").trim())
      .filter((caption) => caption.length > 0);

    if (typeof client.getFileLink !== "function") {
      logger.warn(
        { chatId },
        "telegram adapter: media group but client lacks getFileLink — captions only",
      );
      if (captions.length > 0) runTurn(topic, captions.join("\n"), chatId, threadId);
      else reply(chatId, threadId, "this bot cannot download attachments");
      return;
    }

    const promptLines: string[] = [];
    for (const msg of messages) {
      try {
        promptLines.push(...(await ingestMessageFiles(topic.id, msg)));
      } catch (err) {
        logger.warn(
          { err, chatId, topicId: topic.id },
          "telegram adapter: media group attachment intake failed",
        );
        reply(chatId, threadId, errMsg(err, "attachment download failed"));
      }
    }
    if (stopped) return;
    const userText = captions.join("\n");
    if (!userText && promptLines.length === 0) return;
    runTurn(topic, composeAttachmentPrompt(userText, promptLines), chatId, threadId);
  }

  // ── commands ────────────────────────────────────────────────────────
  /** Handle a leading-slash command. Commands never start an AI turn. */
  async function handleCommand(text: string, chatId: number, threadId?: number): Promise<void> {
    const [rawCmd = ""] = text.split(/\s+/);
    const cmd = rawCmd.replace(/@\w+$/, ""); // tolerate "/abort@MyBot" in groups
    const arg = extractCommandArg(text);
    switch (cmd) {
      case "/start": {
        await sendOnboardingGuide(chatId, threadId);
        return;
      }
      case "/abort": {
        const mapping = byKey.get(mappingKey(chatId, threadId));
        reply(
          chatId,
          threadId,
          mapping && abortRoom(mapping.topicId) ? "aborted" : "nothing running",
        );
        return;
      }
      case "/agent": {
        if (!isAgentKind(arg)) {
          reply(chatId, threadId, "usage: /agent <claude|codex|maestro>");
          return;
        }
        // Agent switch = remap to an agent-suffixed sibling topic (e.g.
        // `tg-123-claude`) so each agent keeps its own session history.
        try {
          const topic = getOrCreateTopic(`${titleFor(chatId, threadId)}-${arg}`, arg);
          bindMapping(chatId, threadId, topic.id);
          reply(chatId, threadId, `agent set to ${arg} — topic "${topic.title}"`);
        } catch (err) {
          reply(chatId, threadId, errMsg(err, "agent switch failed"));
        }
        return;
      }
      case "/topics": {
        const mine = listTopics().filter(
          (t) => isTopicVisible(t) && t.participants.some((p) => p.userId === userId),
        );
        reply(
          chatId,
          threadId,
          mine.length
            ? mine.map((t) => `- ${t.title}${t.agent ? ` (${t.agent})` : ""}`).join("\n")
            : "no topics",
        );
        return;
      }
      case "/new": {
        if (!arg) {
          const mapping = byKey.get(mappingKey(chatId, threadId));
          const topic = mapping ? getTopic(mapping.topicId) : null;
          if (!topic) {
            reply(chatId, threadId, "nothing to reset — this chat has no topic yet");
            return;
          }
          try {
            const result = await restartTopicSession(topic.id, userId, "telegram-session-reset");
            reply(chatId, threadId, result.text);
          } catch (err) {
            reply(chatId, threadId, errMsg(err, "session reset failed"));
          }
          return;
        }
        try {
          const topic = registerTopicLocal({
            title: arg,
            userId,
            kind: "agent",
            ...(opts.defaultAgent ? { agent: opts.defaultAgent } : {}),
          });
          bindMapping(chatId, threadId, topic.id);
          reply(chatId, threadId, `switched to new topic "${topic.title}"`);
        } catch (err) {
          if (err instanceof TopicValidationError) {
            reply(chatId, threadId, err.message);
          } else {
            reply(chatId, threadId, errMsg(err, "topic create failed"));
          }
        }
        return;
      }
      case "/load": {
        if (!arg) {
          reply(chatId, threadId, "usage: /load <topic>");
          return;
        }
        const candidate = getTopicByNameForUser(arg, userId) ?? getTopic(arg);
        const topic = candidate && isTopicVisible(candidate) ? candidate : null;
        if (!topic || !loadExistingTopic(chatId, topic.id, threadId)) {
          reply(chatId, threadId, `no visible topic matching "${arg}"`);
          return;
        }
        reply(chatId, threadId, `loaded topic "${topic.title}"`);
        return;
      }
      case "/unload": {
        if (!unloadMapping(chatId, threadId)) {
          reply(chatId, threadId, "this chat has no loaded topic");
          return;
        }
        reply(chatId, threadId, "unloaded topic; the Negotium topic was preserved");
        return;
      }
      case "/fork":
      case "/spawn": {
        const label = cmd.slice(1);
        const mapping = byKey.get(mappingKey(chatId, threadId));
        if (!mapping) {
          reply(chatId, threadId, `nothing to ${label} — this chat has no topic yet`);
          return;
        }
        // fork = config + history copy; spawn = config only, fresh session.
        const copyHistory = cmd === "/fork";
        void createDerivedTopic(
          mapping.topicId,
          userId,
          copyHistory,
          arg ? { name: arg } : undefined,
        )
          .then((derived) => {
            if (!derived) {
              reply(chatId, threadId, `${label} failed`);
              return;
            }
            // Forum mode materializes the new topic's thread via its
            // topic-created broadcast — nothing else to do here.
            reply(
              chatId,
              threadId,
              `${copyHistory ? "forked into" : "spawned"} "${derived.title}"`,
            );
          })
          .catch((err) => {
            reply(
              chatId,
              threadId,
              err instanceof TopicTitleConflictError ? err.message : errMsg(err, `${label} failed`),
            );
          });
        return;
      }
      case "/del":
      case "/del!": {
        const force = cmd === "/del!";
        const mapping = byKey.get(mappingKey(chatId, threadId));
        const topic = arg
          ? getTopicByNameForUser(arg, userId)
          : mapping
            ? getTopic(mapping.topicId)
            : null;
        if (!topic) {
          reply(
            chatId,
            threadId,
            arg ? `no topic named "${arg}"` : "this chat has no topic — usage: /del [name]",
          );
          return;
        }
        // Notice BEFORE the cascade — if the target is this forum thread, the
        // thread is gone right after (clawgram's ordering quirk).
        reply(chatId, threadId, `deleting topic "${topic.title}"…`);
        // Mapping/thread cleanup rides the core topic-deleted bus event.
        void deleteTopicCascade(topic, userId, { force }).catch((err) => {
          if (err instanceof TopicArchiveRequiredError) {
            reply(
              chatId,
              threadId,
              `delete blocked: archiving "${topic.title}" failed and deleting now would lose its history. ` +
                `Retry after fixing the archive, or force with: /del!${arg ? ` ${arg}` : ""}`,
            );
          } else {
            reply(chatId, threadId, errMsg(err, "delete failed"));
          }
        });
        return;
      }
      default:
        reply(
          chatId,
          threadId,
          "commands: /new [name], /topics, /agent <claude|codex|maestro>, " +
            "/load <topic>, /unload, /fork [name], /spawn [name], " +
            "/del [name], /del! [name], /abort",
        );
    }
  }

  function handleIncomingMessage(msg: TelegramIncomingMessage): void {
    if (stopped) return;
    const chatId = msg.chat.id;
    // General can contain generic reply threads with message_thread_id, but it
    // is not a forum topic. Only is_topic_message=true may select an agent room.
    const generalForumMessage =
      msg.chat.type === "supergroup" && msg.chat.is_forum === true && msg.is_topic_message !== true;
    const threadId = generalForumMessage ? undefined : msg.message_thread_id;
    const text = msg.text?.trim();
    const hasMedia = Boolean(msg.photo?.length || msg.document || msg.voice);
    const privateDm = msg.chat.type === "private";
    const firstPrivateContact = privateDm && !byKey.has(mappingKey(chatId));

    if (privateDm) ownerDmChatIds.add(chatId);
    if (privateDm || (forumMode && chatId === forumChat && threadId === undefined)) {
      bindMapping(chatId, threadId, personalGeneral.id);
    }
    if (firstPrivateContact && text !== "/start") {
      void sendOnboardingGuide(chatId);
    }

    if (text?.startsWith("/")) {
      // Abort is an out-of-band control and must not wait behind a slow file
      // download. Other commands participate in arrival ordering because they
      // can change the chat's topic mapping.
      const command = text.split(/\s+/, 1)[0]?.replace(/@\w+$/, "");
      if (command === "/abort") {
        void handleCommand(text, chatId, threadId);
      } else {
        enqueueInbound(chatId, threadId, () => handleCommand(text, chatId, threadId));
      }
      return;
    }
    if (hasMedia) {
      if (msg.media_group_id) {
        bufferMediaGroup(msg, chatId, threadId); // album item — one turn on flush
        return;
      }
      enqueueInbound(chatId, threadId, () => handleMediaMessage(msg, chatId, threadId));
      return;
    }
    if (!text) return;
    enqueueInbound(chatId, threadId, () =>
      runTurn(resolveMapping(chatId, threadId), text, chatId, threadId),
    );
  }

  client.on("message", (msg: TelegramIncomingMessage) => {
    if (stopped) return;
    // Whitelist rejection is silent — same posture as clawgram (don't leak
    // the bot's existence to strangers) and no topic is ever created.
    if (!isAllowed(msg.from?.id)) return;

    if (msg.chat.type === "supergroup" && msg.chat.is_forum) {
      if (forumMode && msg.chat.id !== forumChat) return;
      if (!forumMode || !forumManageTopicsAvailable) {
        void tryAutoConnectFromMessage(msg).then((connected) => {
          if (connected && !stopped) handleIncomingMessage(msg);
        });
        return;
      }
    }
    handleIncomingMessage(msg);
  });

  client.on("my_chat_member", (update: TelegramMyChatMemberUpdate) => {
    if (stopped || update.chat.type !== "supergroup" || !update.chat.is_forum) return;
    const status = update.new_chat_member?.status;
    if ((status === "left" || status === "kicked") && forumChat === update.chat.id) {
      void disconnectForum(update.chat.id).catch((err) =>
        logger.warn({ err, groupId: update.chat.id }, "telegram adapter: forum disconnect failed"),
      );
      return;
    }
    if (
      forumMode &&
      forumChat === update.chat.id &&
      status !== "administrator" &&
      status !== "creator"
    ) {
      const permissionWasAvailable = forumManageTopicsAvailable;
      forumManageTopicsAvailable = false;
      if (permissionWasAvailable) {
        void notifyOwnerDms(
          'The bot no longer has forum administrator access. Existing topics are preserved; restore administrator + "Manage Topics" to resume topic creation.',
        );
      }
      return;
    }
    if (
      (status !== "administrator" && status !== "creator") ||
      update.from?.id === undefined ||
      (!isAllowed(update.from.id) && (!forumMode || forumChat !== update.chat.id))
    ) {
      return;
    }
    void linkForumAndAnnounce(update.from.id, update.chat, update.new_chat_member!).catch((err) =>
      logger.warn({ err, groupId: update.chat.id }, "telegram adapter: forum auto-connect failed"),
    );
  });

  // ── outbound: RuntimeBus → Telegram ─────────────────────────────────
  const unsubscribe = runtimeBus().subscribe((event) => {
    if (stopped) return;
    if (event.type === "topic-created" && forumMode) {
      materializeTopic(event.payload as TopicDto);
      return;
    }
    if (event.type === "topic-deleted") {
      handleTopicDeleted(event.topicId);
      return;
    }
    if (event.type === "message-updated") {
      const payload = event.payload as {
        messageId?: string;
        patch?: Partial<MessageDto>;
      };
      if (!payload.messageId || !payload.patch) return;
      if (payload.patch.deleted) {
        deleteDeliveredRuntimeMessage(event.topicId, payload.messageId);
        return;
      }
      const current = runtimeMessages.get(payload.messageId);
      if (!current) return;
      const updated = { ...current, ...payload.patch };
      runtimeMessages.set(payload.messageId, updated);
      if (footerEnabled && payload.patch.usage && updated.authorId === "ai") {
        const footer = renderTurnFooter(updated);
        if (footer) attachUpdatedFooter(event.topicId, payload.messageId, footer);
      }
      return;
    }
    if (event.type === "ai-status") {
      // Telegram typing actions expire after a few seconds. Keep refreshing
      // while the turn is active so long tool/model waits still look alive.
      const status = event.payload as { kind?: string; queryId?: string } | null;
      if (status?.kind === "ai_active" && typeof client.sendChatAction === "function") {
        if (status.queryId) startTypingHeartbeat(event.topicId, status.queryId);
        else sendTyping(event.topicId);
      }
      if (
        status?.queryId &&
        (status.kind === "ai_done" || status.kind === "ai_error" || status.kind === "ai_aborted")
      ) {
        stopTypingHeartbeat(status.queryId);
        targetByQueryId.delete(status.queryId);
        clearQueryDeliveryState(status.queryId);
      }
      return;
    }
    if (event.type !== "message") return;
    const msg = event.payload as MessageDto;
    if (msg.authorId === userId) return; // echo of the user's own inbound message
    if (msg.kind === "tool") return; // tool chatter stays off the chat
    if (!msg.text) return;
    const runtimeMessageId = msg.authorId === "ai" ? msg.id : undefined;
    if (runtimeMessageId) {
      runtimeMessages.set(runtimeMessageId, msg);
      if (!msg.queryId) {
        const timer = setTimeout(() => {
          runtimeMessages.delete(runtimeMessageId);
          deliveredByRuntimeMessageId.delete(runtimeMessageId);
        }, 5 * 60_000);
        timer.unref?.();
      }
    }
    // Produced files ride as real attachments; the raw [FILE:] tags are noise.
    const files = extractFileTagPaths(msg.text);
    const text = files.length > 0 ? stripFileTags(msg.text) : msg.text;
    if (!text && files.length === 0) return;
    routeMessage(event.topicId, { text, files, runtimeMessageId }, msg.queryId);
  });

  return {
    name: "telegram",
    loadTopic: loadExistingTopic,
    unloadTopic: unloadMapping,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (outboxTimer !== undefined) {
        clearTimeout(outboxTimer);
        outboxTimer = undefined;
      }
      for (const timer of typingHeartbeatByQueryId.values()) clearInterval(timer);
      typingHeartbeatByQueryId.clear();
      // Clawgram's clearMediaGroupBuffer behavior: cancel timers and DROP
      // buffered album items — a flush must not fire into a stopped adapter.
      for (const entry of mediaGroups.values()) {
        clearTimeout(entry.timer);
        entry.release();
      }
      mediaGroups.clear();
      inboundQueues.clear();
      unsubscribe();
      store.close();
    },
  };
}
