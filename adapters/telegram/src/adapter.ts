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
 *     one topic; group-scoped topics have one materialized thread), persisted in
 *     SQLite so restarts keep routing established threads,
 *   - inbound text/media → whitelist check → slash commands (/new /topics
 *     /agent /fork /spawn /del /del! /abort /vault) → attachment download into the
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
import { basename, extname } from "node:path";
import type { NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import { createDurableOutboxWorker } from "@negotium/adapter-sdk/outbox";
import {
  type AgentKind,
  claimDeliveryAck,
  ensurePersonalGeneral,
  errMsg,
  extractFileTagPaths,
  findTopicTitleConflict,
  getTopic,
  getTopicByNameForUser,
  heartbeatRuntimeEventConsumer,
  isSensitivePath,
  isTopicVisible,
  isTranscriptionConfigured,
  latestRuntimeEventSeq,
  listRuntimeEventsAfter,
  listTopics,
  logger,
  type MessageDto,
  type RegisterTopicOptions,
  type RuntimeBusEvent,
  renderTurnFooter,
  resolveDeliveryAck,
  resolveUploadedFilePathByFileId,
  runtimeBus,
  setTopicSurfaceScope,
  setTopicSurfaces,
  type startAiTurn,
  stripFileTags,
  submitRuntimeGatewayTurn,
  submitUserMessage,
  type TopicDto,
  topicService,
  transcribeAudio,
} from "@negotium/core";
import { RuntimeGatewayError } from "@negotium/core/runtime-gateway";
import { createTelegramCommandRouter } from "@/commands";

/**
 * Settings key marking that mapped rooms were moved onto the telegram surface.
 * Stored in this adapter's own database because the mapping it is derived from
 * lives there too.
 */
const SURFACE_BACKFILL_FLAG = "surface_backfill_20260808";
const GROUP_SCOPE_BACKFILL_FLAG = "telegram_group_scope_backfill_20260829";

function telegramGroupScope(chatId: number): string {
  return `tg:${chatId}`;
}

function telegramGroupIdFromScope(scope: string | null | undefined): number | null {
  if (!scope?.startsWith("tg:")) return null;
  const chatId = Number(scope.slice(3));
  return Number.isSafeInteger(chatId) ? chatId : null;
}

function telegramClientMessageId(
  msg: TelegramIncomingMessage | undefined,
  chatId: number,
  threadId: number | undefined,
): string {
  const messageId = msg?.message_id;
  const source = msg?.media_group_id
    ? Number.isSafeInteger(messageId)
      ? `album:${msg.media_group_id}:${messageId}`
      : `album:${msg.media_group_id}:legacy:${randomUUID()}`
    : Number.isSafeInteger(messageId)
      ? `message:${messageId}`
      : `legacy:${randomUUID()}`;
  return `telegram:${chatId}:${threadId ?? "main"}:${source}`;
}

function telegramActorLabel(msg: TelegramIncomingMessage | undefined): string | undefined {
  const username = msg?.from?.username?.trim().replace(/^@/, "");
  return username ? `@${username}` : undefined;
}

import { type OutboxEntry, openMappingStore, type PersistedMapping } from "@/mapping-store";
import { createTelegramMediaIntake } from "@/media-intake";
import { renderOutbound } from "@/render";
import {
  canManageTopics,
  defaultTopicTitle,
  isChatAdmin,
  isForumTopicAlreadyGone,
  isHtmlParseError,
  isManageTopicsPermissionError,
  isRetryableSendError,
  onboardingGuide,
  type TelegramErrorInfo,
  telegramErrorInfo,
} from "@/telegram-api";
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
  /**
   * Telegram user-id whitelist; empty/absent = allow all.
   *
   * Kept permissive for embedders and tests that deliberately want an open
   * channel. The standalone CLI does NOT rely on this default: it resolves the
   * mode through `parseTelegramAuthEnv`, which refuses to start without either
   * an allowlist or an explicit `TELEGRAM_ALLOW_ALL=true`.
   */
  allowedUsers?: string[];
  /**
   * Telegram user id allowed to manage the shared node Vault. The owner must
   * also appear in `allowedUsers`. A sole allowlisted user is inferred for
   * backwards compatibility; multiple users require this option explicitly.
   * Vault commands are disabled when the allowlist is empty.
   */
  vaultOwnerTelegramUserId?: string;
  /** Agent for auto-created topics; unset = registerTopic's default (maestro). */
  defaultAgent?: "claude" | "codex" | "maestro";
  /** Turn dispatcher override for remote hosts and deterministic tests. */
  startTurn?: typeof startAiTurn;
  /** Submit a user turn through a canonical remote Node instead of this process. */
  submitTurn?: (input: {
    topic: TopicDto;
    userId: string;
    clientMessageId: string;
    actorLabel?: string;
    text: string;
    sourceAdapter: "telegram";
    visualTools: false;
    fileDeliveryTools: true;
  }) => Promise<{ queryId?: string }>;
  /** Abort through the canonical Node when this adapter is a sidecar process. */
  abortTurn?: (topicId: string, userId: string) => Promise<boolean> | boolean;
  /** Topic title for a chat/thread; default `tg-{chatId}` / `tg-{chatId}-{threadId}`. */
  topicTitleFor?: (chatId: number, threadId?: number) => string;
  /**
   * Optional operator-configured initial forum. Additional groups can
   * auto-connect at runtime; each gets its own canonical namespace and General
   * manager. Requires the client's forum surface.
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
interface OutboundFile {
  path: string;
  filename: string;
  mimeType?: string;
}

interface OutboundPayload {
  text: string;
  files: OutboundFile[];
  runtimeMessageId?: string;
  deliveryAckRequested?: boolean;
  onSettled?: (success: boolean) => void;
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

interface ToolStatusRef {
  mapping: ChatMapping;
  messageId: number;
}

interface ToolStatusState {
  closed: boolean;
  refs: Map<string, ToolStatusRef>;
  queue: Promise<void>;
}

/** Telegram caps forum topic names at 128 characters. */
const FORUM_TOPIC_NAME_MAX = 128;
/** DM fallback: how far up the parentTopicId chain to look for a mapped
 *  ancestor (spawn_subagent children can nest). */
const MAX_PARENT_HOPS = 5;
const DEFAULT_SEND_TIMEOUT_MS = 60_000;
/** Extensions delivered via sendPhoto (mirrors clawgram's IMAGE_EXTS). */
const PHOTO_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export function startTelegramAdapter(opts: TelegramAdapterOptions): TelegramAdapterHandle {
  const { client, forumChatId } = opts;
  const userId = opts.userId ?? "local";
  const allowed = new Set((opts.allowedUsers ?? []).map((s) => s.trim()).filter(Boolean));
  const configuredVaultOwner = opts.vaultOwnerTelegramUserId?.trim();
  if (configuredVaultOwner && !allowed.has(configuredVaultOwner)) {
    throw new Error("vaultOwnerTelegramUserId must appear in allowedUsers");
  }
  const vaultOwnerTelegramUserId =
    configuredVaultOwner || (allowed.size === 1 ? allowed.values().next().value : undefined);
  const isAllowed = (telegramUserId: number | undefined): boolean =>
    allowed.size === 0 || allowed.has(String(telegramUserId));
  const isVaultOwner = (telegramUserId: number | undefined): boolean =>
    vaultOwnerTelegramUserId !== undefined && String(telegramUserId) === vaultOwnerTelegramUserId;
  const titleFor = opts.topicTitleFor ?? defaultTopicTitle;
  const sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const typingHeartbeatMs = Math.max(250, opts.typingHeartbeatMs ?? 4_000);
  const footerEnabled = opts.footer === true;
  const store = openMappingStore(opts.mappingDbPath);
  const restoredForumChatId = store.loadForumChatId();
  if (forumChatId !== undefined) {
    store.saveGroup({ chatId: forumChatId });
    store.saveForumChatId(forumChatId);
  }
  interface ForumGroupState {
    chatId: number;
    manageTopicsAvailable: boolean;
    configured: boolean;
    permissionRevision: number;
  }
  const forumGroups = new Map<number, ForumGroupState>();
  for (const group of store.loadGroups()) {
    forumGroups.set(group.chatId, {
      chatId: group.chatId,
      manageTopicsAvailable: group.chatId === forumChatId,
      configured: group.chatId === forumChatId,
      permissionRevision: 0,
    });
  }
  if (restoredForumChatId !== undefined && !forumGroups.has(restoredForumChatId)) {
    forumGroups.set(restoredForumChatId, {
      chatId: restoredForumChatId,
      manageTopicsAvailable: false,
      configured: false,
      permissionRevision: 0,
    });
  }
  if (forumGroups.size > 0 && typeof client.createForumTopic !== "function") {
    logger.warn(
      { forumChatIds: [...forumGroups.keys()] },
      "telegram adapter: forum groups configured but client lacks createForumTopic",
    );
  }
  const personalGeneral = ensurePersonalGeneral(userId, "telegram");
  const groupGenerals = new Map<number, TopicDto>();
  const generalForGroup = (chatId: number): TopicDto => {
    const existing = groupGenerals.get(chatId);
    if (existing) return existing;
    const general = ensurePersonalGeneral(userId, "telegram", {
      surfaceScope: telegramGroupScope(chatId),
    });
    groupGenerals.set(chatId, general);
    return general;
  };

  // ── mapping state ───────────────────────────────────────────────────
  // Two indexes over the same ChatMapping objects. byKey is 1:1 (a chat or
  // thread shows exactly one topic — UNIQUE(chat_id, thread_id) in the
  // store); byTopic fans out (a topic may render into several chats/threads,
  // e.g. a DM chat and a forum thread bound to the same room).
  const byKey = new Map<string, ChatMapping>(); // `${chatId}` | `${chatId}:${threadId}`
  const byTopic = new Map<string, Set<ChatMapping>>();
  const targetByQueryId = new Map<string, ChatMapping>();
  const typingHeartbeatByQueryId = new Map<string, ReturnType<typeof setInterval>>();
  const toolStatusByQueryId = new Map<string, ToolStatusState>();
  const runtimeMessages = new Map<string, MessageDto>();
  const deliveredByRuntimeMessageId = new Map<string, DeliveredMessageRef[]>();
  const deletedRuntimeMessageIds = new Set<string>();
  const activeRuntimeDeliveries = new Map<string, number>();
  const completedRuntimeMessageCleanup = new Set<string>();
  const forumCleanupInFlight = new Set<string>();
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

  function showToolStatus(topicId: string, queryId: string, label: string): void {
    // A status message is only safe when it can be removed at turn end.
    const deleteMessage = client.deleteMessage?.bind(client);
    if (!deleteMessage) return;
    let state = toolStatusByQueryId.get(queryId);
    if (!state) {
      state = { closed: false, refs: new Map(), queue: Promise.resolve() };
      toolStatusByQueryId.set(queryId, state);
    }
    const current = state;
    const text = `🔧 ${label}`.slice(0, 512);
    current.queue = current.queue.then(async () => {
      if (stopped || current.closed) return;
      for (const mapping of typingTargets(topicId, queryId)) {
        if (stopped || current.closed) return;
        const key = mappingKey(mapping.chatId, mapping.threadId);
        const existing = current.refs.get(key);
        if (existing && typeof client.editMessageText === "function") {
          try {
            await client.editMessageText(text, {
              chat_id: mapping.chatId,
              message_id: existing.messageId,
            });
            continue;
          } catch (err) {
            if (/message is not modified/i.test(telegramErrorInfo(err).description)) continue;
            current.refs.delete(key);
            await deleteMessage(mapping.chatId, existing.messageId).catch(() => {});
          }
        } else if (existing) {
          current.refs.delete(key);
          await deleteMessage(mapping.chatId, existing.messageId).catch(() => {});
        }
        try {
          const sent = await client.sendMessage(mapping.chatId, text, threadOpts(mapping.threadId));
          const messageId = sentMessageId(sent);
          if (messageId === null) continue;
          if (stopped || current.closed) {
            await deleteMessage(mapping.chatId, messageId).catch(() => {});
          } else {
            current.refs.set(key, { mapping, messageId });
          }
        } catch (err) {
          logger.warn(
            { err, topicId, queryId, chatId: mapping.chatId },
            "telegram adapter: tool status send failed",
          );
        }
      }
      if (!current.closed) sendTyping(topicId, queryId);
    });
  }

  function closeToolStatus(queryId: string): void {
    const state = toolStatusByQueryId.get(queryId);
    if (!state) return;
    state.closed = true;
    state.queue = state.queue.then(async () => {
      if (typeof client.deleteMessage === "function") {
        for (const { mapping, messageId } of state.refs.values()) {
          await client.deleteMessage(mapping.chatId, messageId).catch(() => {});
        }
      }
      state.refs.clear();
      if (toolStatusByQueryId.get(queryId) === state) toolStatusByQueryId.delete(queryId);
    });
  }

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
    if (forumGroups.has(chatId)) {
      const topic = getTopic(topicId);
      const expectedScope = telegramGroupScope(chatId);
      if (
        !topic ||
        topic.surface !== "telegram" ||
        (topic.surfaceScope ?? null) !== expectedScope
      ) {
        throw new Error(
          `refusing to bind Telegram group ${chatId} to topic ${topicId} outside ${expectedScope}`,
        );
      }
      for (const existing of [...(byTopic.get(topicId) ?? [])]) {
        if (existing.chatId !== chatId || mappingKey(existing.chatId, existing.threadId) === key) {
          continue;
        }
        detachFromTopic(existing);
        byKey.delete(mappingKey(existing.chatId, existing.threadId));
        if (persist) store.deleteByChat(existing.chatId, existing.threadId);
      }
    }
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
  function unbindTopic(topicId: string, { persist = true } = {}): void {
    const set = byTopic.get(topicId);
    if (set) {
      for (const mapping of set) byKey.delete(mappingKey(mapping.chatId, mapping.threadId));
      byTopic.delete(topicId);
    }
    if (persist) store.deleteByTopic(topicId);
  }

  /** Keep a stale forum mapping durable until Telegram confirms deletion. If
   *  the request fails or the process stops, startup reconciliation retries it. */
  function cleanupPersistedMapping(mapping: PersistedMapping, logMessage: string): void {
    if (mapping.threadId !== undefined && typeof client.deleteForumTopic === "function") {
      const key = mappingKey(mapping.chatId, mapping.threadId);
      if (forumCleanupInFlight.has(key)) return;
      forumCleanupInFlight.add(key);
      void client
        .deleteForumTopic(mapping.chatId, mapping.threadId)
        .then(() => {
          if (!stopped) store.deleteByChat(mapping.chatId, mapping.threadId);
        })
        .catch((err) => {
          if (isForumTopicAlreadyGone(telegramErrorInfo(err))) {
            if (!stopped) store.deleteByChat(mapping.chatId, mapping.threadId);
            return;
          }
          logger.warn({ err, topicId: mapping.topicId, threadId: mapping.threadId }, logMessage);
        })
        .finally(() => forumCleanupInFlight.delete(key));
      return;
    }
    store.deleteByChat(mapping.chatId, mapping.threadId);
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
    const expectedScope = forumGroups.has(chatId) ? telegramGroupScope(chatId) : null;
    if (
      !topic?.participants.some((participant) => participant.userId === userId) ||
      topic.surface !== "telegram" ||
      (topic.surfaceScope ?? null) !== expectedScope
    ) {
      return false;
    }
    bindMapping(chatId, threadId, topic.id);
    return true;
  }

  // One-time reclassification of rooms this adapter already owns. The chat↔
  // topic mapping lives in this adapter's own database, so the canonical
  // store's surface backfill cannot see it and parks everything on the host
  // default; only this pass can tell a telegram room from a terminal one (S-9).
  if (!store.isFlagSet(SURFACE_BACKFILL_FLAG)) {
    // Manager rooms are one per user *per surface*: the terminal's personal
    // General may be mapped here from before the split, and moving it would
    // delete it from the terminal picker. Telegram makes its own instead.
    const mappedIds = [
      ...new Set(
        store.load().flatMap((mapping) => {
          const topic = getTopic(mapping.topicId);
          return topic &&
            topic.kind !== "manager" &&
            topic.participants.some((participant) => participant.userId === userId)
            ? [topic.id]
            : [];
        }),
      ),
    ];
    const moved = setTopicSurfaces(mappedIds, "telegram");
    store.setFlag(SURFACE_BACKFILL_FLAG);
    if (moved > 0) {
      logger.info(
        { moved, mapped: mappedIds.length },
        "telegram adapter: moved mapped topics onto the telegram surface",
      );
    }
  }

  // Promote the former single-forum mapping into the canonical namespace.
  // DM bindings remain unscoped. A legacy topic mapped into more than one
  // forum is intentionally left untouched: assigning either group would make
  // the other binding cross-scope, and silently cloning conversation/session
  // state is not a safe migration.
  if (!store.isFlagSet(GROUP_SCOPE_BACKFILL_FLAG)) {
    const groupIds = new Set(forumGroups.keys());
    const groupsByTopic = new Map<string, Set<number>>();
    for (const mapping of store.load()) {
      if (!groupIds.has(mapping.chatId)) continue;
      const groups = groupsByTopic.get(mapping.topicId) ?? new Set<number>();
      groups.add(mapping.chatId);
      groupsByTopic.set(mapping.topicId, groups);
    }
    let filed = 0;
    for (const [topicId, groups] of groupsByTopic) {
      if (groups.size !== 1) {
        logger.warn(
          { topicId, groupIds: [...groups] },
          "telegram adapter: legacy topic spans multiple groups; scope migration skipped",
        );
        continue;
      }
      const topic = getTopic(topicId);
      if (
        !topic ||
        topic.kind === "manager" ||
        topic.surface !== "telegram" ||
        !topic.participants.some((participant) => participant.userId === userId)
      ) {
        continue;
      }
      const [chatId] = groups;
      if (chatId !== undefined) {
        const targetScope = telegramGroupScope(chatId);
        const currentScope = topic.surfaceScope ?? null;
        if (currentScope !== null && currentScope !== targetScope) {
          logger.warn(
            { topicId, currentScope, targetScope },
            "telegram adapter: legacy mapping conflicts with an existing topic namespace",
          );
          continue;
        }
        const titleConflict = findTopicTitleConflict(topic.title, topic.kind ?? "agent", {
          excludeTopicId: topic.id,
          surface: "telegram",
          surfaceScope: targetScope,
        });
        if (titleConflict) {
          logger.warn(
            { topicId, conflictTopicId: titleConflict.id, targetScope },
            "telegram adapter: legacy topic title conflicts in target namespace",
          );
          continue;
        }
        filed += Number(setTopicSurfaceScope(topicId, "telegram", targetScope));
      }
    }
    store.setFlag(GROUP_SCOPE_BACKFILL_FLAG);
    if (filed > 0) {
      logger.info({ filed }, "telegram adapter: filed legacy topics into group namespaces");
    }
  }

  // Restore persisted routing so a restart keeps delivering into existing
  // chats/threads instead of materializing duplicates. Prune mappings whose
  // runtime topic disappeared while this adapter was offline; otherwise a
  // deleted topic leaves an orphan Telegram thread forever.
  for (const persisted of store.load()) {
    const topic = getTopic(persisted.topicId);
    const expectedScope = forumGroups.has(persisted.chatId)
      ? telegramGroupScope(persisted.chatId)
      : null;
    if (
      topic?.participants.some((participant) => participant.userId === userId) &&
      topic.surface === "telegram" &&
      (topic.surfaceScope ?? null) === expectedScope
    ) {
      bindMapping(persisted.chatId, persisted.threadId, persisted.topicId, { persist: false });
      continue;
    }
    if (topic) {
      store.deleteByChat(persisted.chatId, persisted.threadId);
      logger.warn(
        {
          chatId: persisted.chatId,
          threadId: persisted.threadId,
          topicId: persisted.topicId,
          topicSurface: topic.surface,
          topicSurfaceScope: topic.surfaceScope ?? null,
          expectedScope,
        },
        "telegram adapter: quarantined mapping outside its topic namespace",
      );
      continue;
    }
    cleanupPersistedMapping(persisted, "telegram adapter: stale forum thread cleanup failed");
  }

  function reconcileStaleMappings(): void {
    for (const persisted of store.load()) {
      const topic = getTopic(persisted.topicId);
      if (!topic?.participants.some((participant) => participant.userId === userId)) {
        cleanupPersistedMapping(persisted, "telegram adapter: stale forum thread cleanup failed");
      }
    }
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
      // Rooms this adapter creates belong to the telegram surface, whatever the
      // host default is — that is what keeps them out of the terminal picker
      // and lets the same title exist on another surface (S-1, S-6).
      return topicService.create({ ...options, surface: "telegram" });
    } finally {
      suppressMaterialize--;
    }
  }

  /** Reuse a topic by name if this node already has it, else create one. */
  function getOrCreateTopic(chatId: number, title: string, agent?: AgentKind): TopicDto {
    const surfaceScope = forumGroups.has(chatId) ? telegramGroupScope(chatId) : null;
    return (
      getTopicByNameForUser(title, userId, { surface: "telegram", surfaceScope }) ??
      registerTopicLocal({
        title,
        userId,
        kind: "agent",
        surfaceScope,
        ...(agent ? { agent } : {}),
      })
    );
  }

  function resolveMapping(chatId: number, threadId?: number): TopicDto {
    const cached = byKey.get(mappingKey(chatId, threadId));
    if (cached) {
      const topic = getTopic(cached.topicId);
      if (topic) return topic;
      unbindTopic(cached.topicId); // topic vanished underneath the mapping
    }
    const topic = getOrCreateTopic(chatId, titleFor(chatId, threadId), opts.defaultAgent);
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

  interface TelegramOutboxDelivery {
    sentValue: unknown;
    sentText: string;
    sentAsHtml: boolean;
  }

  const outboxWorker = createDurableOutboxWorker<OutboxEntry, TelegramOutboxDelivery>({
    policy: outboxCfg,
    store: {
      due: (now) => store.outboxDue(now),
      hasPending: () => store.outboxAll().some((entry) => !entry.dead),
      acknowledge: async (entry, delivery) => {
        store.outboxDelete(entry.id);
        const telegramMessageId = sentMessageId(delivery.sentValue);
        if (!entry.runtimeMessageId || telegramMessageId === null) return;
        const ref: DeliveredMessageRef = {
          chatId: entry.chatId,
          threadId: entry.threadId,
          messageId: telegramMessageId,
          kind: "text",
          text: delivery.sentText,
          html: delivery.sentAsHtml,
          ...(entry.footer ? { footer: entry.footer } : {}),
        };
        if (deletedRuntimeMessageIds.has(entry.runtimeMessageId)) {
          await deleteDeliveredRefs(entry.runtimeMessageId, [ref]);
        } else {
          rememberDeliveredRefs(entry.runtimeMessageId, [ref]);
        }
      },
      discard: (entry) => {
        store.outboxDelete(entry.id);
      },
      retry: (entry, retry) => {
        store.outboxReschedule(entry.id, retry.attempts, retry.nextTryAt, retry.error);
      },
      deadLetter: (entry, retry) => {
        store.outboxMarkDead(entry.id, retry.attempts, retry.error);
      },
    },
    shouldDiscard: (entry) =>
      Boolean(entry.runtimeMessageId && deletedRuntimeMessageIds.has(entry.runtimeMessageId)),
    deliver: async (entry) => {
      try {
        const sentValue = await client.sendMessage(entry.chatId, entry.html, {
          ...threadOpts(entry.threadId),
          parse_mode: "HTML",
        });
        return { sentValue, sentText: entry.html, sentAsHtml: true };
      } catch (error) {
        if (!isHtmlParseError(telegramErrorInfo(error))) throw error;
        const sentValue = await client.sendMessage(
          entry.chatId,
          entry.plain,
          threadOpts(entry.threadId),
        );
        return { sentValue, sentText: entry.plain, sentAsHtml: false };
      }
    },
    classifyError: (error) => {
      const info = telegramErrorInfo(error);
      return {
        message: info.description || info.code || "send failed",
        ...(info.status === 429 && info.retryAfterSec !== undefined
          ? { retryAfterMs: Math.max(info.retryAfterSec * 1000, 0) }
          : {}),
      };
    },
    onEntryStart: (entry) => beginRuntimeDelivery(entry.runtimeMessageId),
    onEntryEnd: (entry) => endRuntimeDelivery(entry.runtimeMessageId),
    onDeadLetter: (entry, retry) => {
      logger.warn(
        { id: entry.id, chatId: entry.chatId, attempts: retry.attempts, error: retry.error },
        "telegram adapter: outbox entry dead-lettered after max attempts",
      );
    },
    onError: (error) => {
      logger.warn({ err: error }, "telegram adapter: outbox flush failed");
    },
  });
  outboxWorker.start();

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
    outboxWorker.wake();
  }

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

  /** Outcome of one file-send attempt. `delivered` is true only when the
   *  file's actual bytes reached Telegram (sendPhoto/sendDocument) — the
   *  missing-file and no-file-surface fallbacks still produce a `ref` (a
   *  text notice was sent) but are not a real delivery of the attachment. */
  interface SendFileOutcome {
    ref: DeliveredMediaRef | null;
    delivered: boolean;
    error?: string;
  }

  /** Send one produced file (from a [FILE:] tag, or a resolved send_file/
   *  send_files attachment): photos by extension via sendPhoto, everything
   *  else via sendDocument; sensitive paths blocked; missing files surface
   *  as a plain-text notice (model intent was explicit). */
  async function sendFile(
    chatId: number,
    threadId: number | undefined,
    file: OutboundFile,
  ): Promise<SendFileOutcome> {
    const { path } = file;
    const base = threadOpts(threadId);
    if (isSensitivePath(path)) {
      logger.warn({ path, chatId }, "telegram adapter: blocked sensitive file path");
      return { ref: null, delivered: false, error: "path matches the sensitive-file blacklist" };
    }
    if (!existsSync(path)) {
      const sent = await client.sendMessage(chatId, `File: ${path}`, base).catch(() => null);
      const messageId = sentMessageId(sent);
      return {
        ref: messageId === null ? null : { messageId, kind: "media" },
        delivered: false,
        error: "file not found on disk",
      };
    }
    const ext = extname(path).slice(1).toLowerCase();
    const fileOptions = {
      filename: basename(file.filename) || basename(path),
      ...(file.mimeType ? { contentType: file.mimeType } : {}),
    };
    try {
      let sent: unknown;
      let delivered = true;
      let error: string | undefined;
      if (PHOTO_EXTS.has(ext) && typeof client.sendPhoto === "function") {
        sent = await client.sendPhoto(chatId, path, base, fileOptions);
      } else if (typeof client.sendDocument === "function") {
        sent = await client.sendDocument(chatId, path, base, fileOptions);
      } else {
        // Client has no file surface — at least point the user at the path.
        sent = await client.sendMessage(chatId, `File: ${path}`, base);
        delivered = false;
        error = "this Telegram client cannot send file attachments";
      }
      const messageId = sentMessageId(sent);
      return { ref: messageId === null ? null : { messageId, kind: "media" }, delivered, error };
    } catch (err) {
      logger.warn({ err, path, chatId }, "telegram adapter: file send failed");
      return { ref: null, delivered: false, error: errMsg(err, "file send failed") };
    }
  }

  async function deliverPayload(
    chatId: number,
    threadId: number | undefined,
    payload: OutboundPayload,
  ): Promise<SendFileOutcome[]> {
    if (payload.runtimeMessageId && deletedRuntimeMessageIds.has(payload.runtimeMessageId)) {
      return [];
    }
    beginRuntimeDelivery(payload.runtimeMessageId);
    const deliveredRefs: DeliveredMessageRef[] = [];
    const fileOutcomes: SendFileOutcome[] = [];
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
      for (const file of payload.files) {
        if (payload.runtimeMessageId && deletedRuntimeMessageIds.has(payload.runtimeMessageId)) {
          break;
        }
        const outcome = await sendFile(chatId, threadId, file);
        fileOutcomes.push(outcome);
        if (outcome.ref) deliveredRefs.push({ ...outcome.ref, chatId, threadId });
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
    return fileOutcomes;
  }

  /** Deliver every fan-out target, then publish exactly one aggregate ack. */
  async function deliverToTargets(
    topicId: string,
    targets: Iterable<ChatMapping>,
    payload: OutboundPayload,
  ): Promise<void> {
    const outcomes: SendFileOutcome[] = [];
    for (const target of targets) {
      outcomes.push(...(await deliverPayload(target.chatId, target.threadId, payload)));
    }
    if (!payload.deliveryAckRequested || !payload.runtimeMessageId) return;
    const failed = outcomes.find((outcome) => !outcome.delivered);
    const missing = outcomes.length === 0;
    resolveDeliveryAck(topicId, payload.runtimeMessageId, {
      ok: !failed && !missing,
      ...(failed?.error
        ? { error: failed.error }
        : missing
          ? { error: "attachment path could not be resolved or delivery was cancelled" }
          : {}),
    });
  }

  // Per-topic send chains keep messages ordered even when materialization
  // flushes a buffer while new bus events keep arriving. Each link is capped
  // by a watchdog so one hung sendMessage can't wedge the topic forever, and
  // a drained chain removes its map entry so long-lived processes don't
  // accumulate one settled promise per topic ever spoken to.
  const sendQueues = new Map<string, Promise<boolean>>();
  function enqueueSend(topicId: string, task: () => Promise<void>): Promise<boolean> {
    const prev = sendQueues.get(topicId) ?? Promise.resolve(true);
    const next = prev.then(
      () =>
        new Promise<boolean>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            logger.warn(
              { topicId, sendTimeoutMs },
              "telegram adapter: send timed out — abandoning it and continuing the queue",
            );
            resolve(false);
          }, sendTimeoutMs);
          task()
            .then(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(true);
            })
            .catch((err) => {
              logger.warn({ err, topicId }, "telegram adapter: send task failed");
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(false);
            });
        }),
    );
    sendQueues.set(topicId, next);
    void next.then(() => {
      // Chain-end cleanup: only the tail may delete the entry (a newer link
      // may already have replaced `next`).
      if (sendQueues.get(topicId) === next) sendQueues.delete(topicId);
    });
    return next;
  }

  /** Deliver into every chat/thread currently bound to the topic, in order. */
  function enqueueFanout(
    topicId: string,
    mappings: Iterable<ChatMapping>,
    payload: OutboundPayload,
  ): void {
    const targets = [...mappings];
    void enqueueSend(topicId, () => deliverToTargets(topicId, targets, payload)).then(
      payload.onSettled,
    );
  }

  function enqueueTarget(topicId: string, target: ChatMapping, payload: OutboundPayload): void {
    void enqueueSend(topicId, () => deliverToTargets(topicId, [target], payload)).then(
      payload.onSettled,
    );
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
  if (forumGroups.size > 0) {
    for (const t of store.loadTombstones()) materializeTombstones.set(t.topicId, t.title);
  }

  function deliverFallback(
    topicId: string,
    title: string,
    payload: OutboundPayload,
  ): Promise<void> {
    const topic = getTopic(topicId);
    const chatId = telegramGroupIdFromScope(topic?.surfaceScope);
    if (chatId === null) return Promise.resolve();
    return deliverToTargets(topicId, [{ chatId, topicId }], {
      text: payload.text ? `[${title}] ${payload.text}` : "",
      files: payload.files,
      runtimeMessageId: payload.runtimeMessageId,
      deliveryAckRequested: payload.deliveryAckRequested,
    });
  }

  function flushBuffered(
    topicId: string,
    buffer: OutboundPayload[],
    send: (payload: OutboundPayload) => Promise<void>,
  ): void {
    for (const payload of buffer) {
      void enqueueSend(topicId, () => send(payload)).then(payload.onSettled);
    }
  }

  function materializeTopic(topic: TopicDto): boolean {
    if (
      topic.surface !== "telegram" ||
      !topic.participants?.some((participant) => participant.userId === userId)
    ) {
      return false;
    }
    const materializationChat = telegramGroupIdFromScope(topic.surfaceScope);
    if (materializationChat === null) return false;
    const group = forumGroups.get(materializationChat);
    if (
      !group?.manageTopicsAvailable ||
      suppressMaterialize > 0 ||
      byTopic.has(topic.id) ||
      pendingByTopic.has(topic.id) ||
      permissionBlockedTopics.has(topic.id) ||
      materializeTombstones.has(topic.id)
    ) {
      return false;
    }
    if (!isTopicVisible(topic)) return false;
    // Only rooms that live on THIS surface (S-6). The bootstrap caller already
    // filters with `listTopics({ surface: "telegram" })`, but the `topic-created`
    // bus subscription hands over whatever was just created — so making a topic
    // in the Terminal spawned a Telegram forum room for it. The check belongs
    // here rather than at the four call sites: guarding the callers is exactly
    // the pattern that let this one through while the others looked correct.
    const pending: PendingMaterialization = { buffer: [], cancelled: false };
    pendingByTopic.set(topic.id, pending);
    void (async () => {
      let created: { message_thread_id: number };
      try {
        // Connected forum groups require the createForumTopic capability.
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
          const permissionWasAvailable = group.manageTopicsAvailable;
          group.manageTopicsAvailable = false;
          permissionBlockedTopics.set(topic.id, topic.title);
          logger.warn(
            { err, topicId: topic.id, title: topic.title },
            "telegram adapter: Manage Topics unavailable — waiting for permission recovery",
          );
          if (permissionWasAvailable) {
            reply(
              materializationChat,
              undefined,
              'Forum topic creation is paused. Enable the bot administrator permission "Manage Topics"; pending topics will be retried automatically.',
            );
          }
          flushBuffered(topic.id, pending.buffer, (payload) =>
            deliverFallback(topic.id, topic.title, payload),
          );
          return;
        }
        logger.warn(
          { err, topicId: topic.id, title: topic.title },
          "telegram adapter: createForumTopic failed permanently — falling back to general chat",
        );
        materializeTombstones.set(topic.id, topic.title);
        store.saveTombstone(topic.id, topic.title);
        flushBuffered(topic.id, pending.buffer, (payload) =>
          deliverFallback(topic.id, topic.title, payload),
        );
        return;
      }
      if (pendingByTopic.get(topic.id) === pending) pendingByTopic.delete(topic.id);
      const threadId = created.message_thread_id;
      if (stopped || pending.cancelled) {
        // Cancelled = the topic was deleted while creation was in flight:
        // persist cleanup intent before deleting the just-created orphan so a
        // failed request can be retried after restart. Bind nothing in memory.
        // Stopped = abandon silently (no post-stop sends, no closed-DB save).
        if (pending.cancelled && typeof client.deleteForumTopic === "function") {
          const orphan = { chatId: materializationChat, threadId, topicId: topic.id };
          store.save(orphan);
          cleanupPersistedMapping(orphan, "telegram adapter: orphan thread cleanup failed");
        }
        return;
      }
      bindMapping(materializationChat, threadId, topic.id);
      flushBuffered(topic.id, pending.buffer, (payload) =>
        deliverToTargets(
          topic.id,
          [{ chatId: materializationChat, threadId, topicId: topic.id }],
          payload,
        ),
      );
    })();
    return true;
  }

  function handleTopicDeleted(topicId: string): void {
    if (materializeTombstones.delete(topicId)) store.deleteTombstone(topicId);
    const pending = pendingByTopic.get(topicId);
    if (pending) {
      pending.cancelled = true; // in-flight creation — its continuation cleans up
      for (const payload of pending.buffer) payload.onSettled?.(true);
      pending.buffer = [];
    }
    for (const [messageId, message] of runtimeMessages) {
      if (message.topicId === topicId) deleteDeliveredRuntimeMessage(topicId, messageId);
    }
    const set = byTopic.get(topicId);
    if (!set) return;
    const mappings = [...set];
    // Stop routing immediately, but keep forum mappings durable until the
    // Telegram API confirms deletion so failures can be retried on restart.
    unbindTopic(topicId, { persist: false });
    for (const mapping of mappings) {
      cleanupPersistedMapping(mapping, "telegram adapter: deleteForumTopic failed");
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

  function routeMessage(topicId: string, payload: OutboundPayload, queryId?: string): boolean {
    const pending = pendingByTopic.get(topicId);
    if (pending) {
      pending.buffer.push(payload); // thread creation in flight — flushed in order later
      return true;
    }
    const specificTarget = queryId ? targetByQueryId.get(queryId) : undefined;
    if (specificTarget) {
      enqueueTarget(topicId, specificTarget, payload);
      return true;
    }
    const mappings = byTopic.get(topicId);
    if (mappings && mappings.size > 0) {
      // A Telegram-owned query has a specific target above. Events produced by
      // Terminal or another surface intentionally fan out to every mapped
      // personal General so the owner's channel views stay synchronized.
      enqueueFanout(topicId, mappings, payload);
      return true;
    }
    const tombstoneTitle = materializeTombstones.get(topicId);
    if (tombstoneTitle !== undefined) {
      void enqueueSend(topicId, () => deliverFallback(topicId, tombstoneTitle, payload)).then(
        payload.onSettled,
      );
      return true;
    }
    const topic = getTopic(topicId);
    if (!topic) return false;
    const groupId = telegramGroupIdFromScope(topic.surfaceScope);
    const group = groupId === null ? undefined : forumGroups.get(groupId);
    if (group) {
      if (!group.manageTopicsAvailable || permissionBlockedTopics.has(topicId)) {
        void enqueueSend(topicId, () => deliverFallback(topicId, topic.title, payload)).then(
          payload.onSettled,
        );
        return true;
      }
      // Lazy materialization: first message for a live topic with no binding
      // (topic predates the adapter, missed topic-created, dropped binding…)
      // — create its thread now instead of silently discarding the message.
      // Same suppress/participant rules as the topic-created path.
      if (!materializeTopic(topic)) return false;
      pendingByTopic.get(topicId)?.buffer.push(payload);
      return true;
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
        deliveryAckRequested: payload.deliveryAckRequested,
      });
      return true;
    }
    return false;
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

  function materializeVisibleTopics(chatId: number): void {
    const group = forumGroups.get(chatId);
    if (!group?.manageTopicsAvailable) return;
    const topics = listTopics({
      surface: "telegram",
      surfaceScope: telegramGroupScope(chatId),
    });
    for (const topic of topics) {
      if (topic.kind === "manager") continue;
      if (
        isTopicVisible(topic) &&
        topic.participants.some((participant) => participant.userId === userId)
      ) {
        materializeTopic(topic);
      }
    }
  }

  function restoreForumTopicCreation(chatId: number, { retryPermanent = false } = {}): void {
    const group = forumGroups.get(chatId);
    if (!group) return;
    group.manageTopicsAvailable = true;
    for (const topicId of [...permissionBlockedTopics.keys()]) {
      if (telegramGroupIdFromScope(getTopic(topicId)?.surfaceScope) === chatId) {
        permissionBlockedTopics.delete(topicId);
      }
    }
    if (retryPermanent) {
      for (const topicId of [...materializeTombstones.keys()]) {
        if (telegramGroupIdFromScope(getTopic(topicId)?.surfaceScope) === chatId) {
          materializeTombstones.delete(topicId);
          store.deleteTombstone(topicId);
        }
      }
    }
    reconcileStaleMappings();
    materializeVisibleTopics(chatId);
  }

  async function notifyOwnerDms(text: string): Promise<void> {
    await Promise.allSettled([...ownerDmChatIds].map((chatId) => client.sendMessage(chatId, text)));
  }

  async function disconnectForum(chatId: number): Promise<boolean> {
    if (!forumGroups.has(chatId)) return false;

    for (const [topicId, pending] of pendingByTopic) {
      if (telegramGroupIdFromScope(getTopic(topicId)?.surfaceScope) !== chatId) continue;
      pending.cancelled = true;
      if (pendingByTopic.get(topicId) === pending) pendingByTopic.delete(topicId);
    }
    for (const mapping of [...byKey.values()]) {
      if (mapping.chatId === chatId) unloadMapping(mapping.chatId, mapping.threadId);
    }
    for (const [queryId, target] of targetByQueryId) {
      if (target.chatId === chatId) targetByQueryId.delete(queryId);
    }

    for (const topicId of [...permissionBlockedTopics.keys()]) {
      if (telegramGroupIdFromScope(getTopic(topicId)?.surfaceScope) === chatId) {
        permissionBlockedTopics.delete(topicId);
      }
    }
    for (const topicId of [...materializeTombstones.keys()]) {
      if (telegramGroupIdFromScope(getTopic(topicId)?.surfaceScope) === chatId) {
        materializeTombstones.delete(topicId);
        store.deleteTombstone(topicId);
      }
    }
    store.outboxDeleteByChat(chatId);
    store.deleteGroup(chatId);
    if (store.loadForumChatId() === chatId) store.clearForumChatId();
    forumGroups.delete(chatId);
    groupGenerals.delete(chatId);

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
    const hasManageTopics = canManageTopics(botMember);
    const existingGroup = forumGroups.get(chat.id);
    if (existingGroup) {
      existingGroup.permissionRevision += 1;
      const recovered = hasManageTopics && !existingGroup.manageTopicsAvailable;
      const lostPermission = !hasManageTopics && existingGroup.manageTopicsAvailable;
      if (hasManageTopics) {
        restoreForumTopicCreation(chat.id, { retryPermanent: recovered });
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
        existingGroup.manageTopicsAvailable = false;
        if (lostPermission) {
          await notifyOwnerDms(
            `Manage Topics permission was removed from “${chat.title?.trim() || chat.id}”. Existing topics are preserved; restore the permission to resume topic creation.`,
          );
        }
      }
      return true;
    }

    forumGroups.set(chat.id, {
      chatId: chat.id,
      manageTopicsAvailable: hasManageTopics,
      configured: chat.id === forumChatId,
      permissionRevision: 1,
    });
    store.saveGroup({
      chatId: chat.id,
      title: chat.title?.trim(),
      ownerTelegramUserId: ownerTelegramId,
    });
    if (store.loadForumChatId() === undefined) store.saveForumChatId(chat.id);
    bindMapping(chat.id, undefined, generalForGroup(chat.id).id);
    ownerDmChatIds.add(ownerTelegramId);

    // Existing agent rooms become forum topics just like rooms created after
    // connection. General is already mapped above and therefore skipped.
    materializeVisibleTopics(chat.id);

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
    const connected = forumGroups.get(msg.chat.id);
    if (connected?.manageTopicsAvailable) return true;
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
      return forumGroups.has(msg.chat.id);
    } catch (err) {
      logger.debug(
        { err, groupId: msg.chat.id, senderId },
        "telegram adapter: lazy forum auto-connect check failed",
      );
      return false;
    }
  }

  async function verifyInitialForumPermissions(): Promise<void> {
    // Snapshot before the first await. Groups connected by live updates while
    // identity resolution is in flight have already been authoritatively
    // checked by linkForumAndAnnounce and must not be downgraded by this
    // startup-only recovery pass.
    const initialGroups = [...forumGroups.values()];
    if (initialGroups.length === 0) return;
    if (typeof client.getMe !== "function" || typeof client.getChatMember !== "function") {
      // Embedded legacy clients cannot expose membership state. Preserve the
      // previous configured-forum behavior instead of disabling the adapter.
      for (const group of initialGroups) {
        if (forumGroups.get(group.chatId) === group) group.manageTopicsAvailable = true;
      }
      return;
    }
    const bot = await resolveBotIdentity();
    if (!bot || stopped) return;
    for (const group of initialGroups) {
      if (forumGroups.get(group.chatId) !== group) continue;
      // A configured group is an operator-owned capability. Preserve the
      // historical embedded-client behavior and do not override it with a
      // best-effort membership probe at startup.
      if (group.configured) continue;
      try {
        const permissionRevision = group.permissionRevision;
        const member = await client.getChatMember(group.chatId, bot.id);
        if (
          forumGroups.get(group.chatId) !== group ||
          group.permissionRevision !== permissionRevision
        ) {
          continue;
        }
        if (member.status === "left" || member.status === "kicked") {
          await disconnectForum(group.chatId);
          continue;
        }
        if (canManageTopics(member)) {
          restoreForumTopicCreation(group.chatId, { retryPermanent: !group.configured });
        } else {
          group.manageTopicsAvailable = false;
        }
      } catch (err) {
        logger.warn(
          { err, forumChatId: group.chatId },
          "telegram adapter: initial forum permission check failed",
        );
      }
    }
  }

  void verifyInitialForumPermissions();

  /** Persist the user message and start the AI turn (single fixed userId). */
  function runTurn(
    topic: TopicDto,
    prompt: string,
    chatId: number,
    threadId: number | undefined,
    sourceMessage?: TelegramIncomingMessage,
  ): void {
    const target: ChatMapping = {
      topicId: topic.id,
      chatId,
      ...(threadId !== undefined ? { threadId } : {}),
    };
    const rememberTarget = (queryId: string): void => {
      targetByQueryId.set(queryId, target);
    };
    const actorLabel = telegramActorLabel(sourceMessage);
    const input = {
      topic,
      userId,
      clientMessageId: telegramClientMessageId(sourceMessage, chatId, threadId),
      ...(actorLabel ? { actorLabel } : {}),
      text: prompt,
      sourceAdapter: "telegram" as const,
      visualTools: false as const,
      fileDeliveryTools: true as const,
    };
    const provisionalQueryId = input.clientMessageId;
    rememberTarget(provisionalQueryId);
    const adoptQueryId = (queryId: string | undefined): void => {
      if (!queryId) return;
      if (queryId !== provisionalQueryId && targetByQueryId.get(provisionalQueryId) === target) {
        targetByQueryId.delete(provisionalQueryId);
      }
      rememberTarget(queryId);
    };
    const removeProvisionalTarget = (): void => {
      if (targetByQueryId.get(provisionalQueryId) === target) {
        targetByQueryId.delete(provisionalQueryId);
      }
    };
    if (opts.submitTurn) {
      void opts
        .submitTurn(input)
        .then(({ queryId }) => {
          adoptQueryId(queryId ?? provisionalQueryId);
        })
        .catch((error) => {
          const mayHaveCommitted =
            error instanceof RuntimeGatewayError &&
            (error.kind === "transport" ||
              error.kind === "timeout" ||
              (error.kind === "http" && (error.status ?? 0) >= 500));
          if (mayHaveCommitted) {
            // A committed turn can still emit after both ACK attempts were lost.
            // Keep origin routing long enough for its terminal event to clean it.
            const timer = setTimeout(removeProvisionalTarget, 60 * 60_000);
            timer.unref?.();
          } else {
            removeProvisionalTarget();
          }
          logger.error({ err: error, topicId: topic.id }, "telegram adapter: remote turn failed");
        });
      return;
    }
    if (opts.startTurn) {
      const { queryId } = submitUserMessage({
        ...input,
        onDispatched: adoptQueryId,
        startTurn: opts.startTurn,
      });
      if (queryId) adoptQueryId(queryId);
      else removeProvisionalTarget();
      return;
    }
    try {
      const submission = submitRuntimeGatewayTurn({
        ...input,
        requestId: input.clientMessageId,
      });
      adoptQueryId(submission.requestId);
    } catch (error) {
      removeProvisionalTarget();
      throw error;
    }
  }

  const mediaIntake = createTelegramMediaIntake({
    client,
    mediaGroup: opts.mediaGroup,
    isStopped: () => stopped,
    mappingKey,
    resolveTopic: resolveMapping,
    runTurn,
    reply,
    transcribe: opts.transcribe ?? ((filePath: string) => transcribeAudio(filePath)),
    transcriptionAvailable: () => opts.transcribe !== undefined || isTranscriptionConfigured(),
  });

  const handleCommand = createTelegramCommandRouter({
    userId,
    defaultAgent: opts.defaultAgent,
    surfaceScopeFor: (chatId) => (forumGroups.has(chatId) ? telegramGroupScope(chatId) : null),
    isForumGeneral: (chatId, threadId) => forumGroups.has(chatId) && threadId === undefined,
    resolveBotUsername: async () => (await resolveBotIdentity())?.username,
    isVaultOwner,
    reply,
    sendOnboardingGuide,
    currentTopicId: (chatId, threadId) => byKey.get(mappingKey(chatId, threadId))?.topicId,
    titleFor,
    getOrCreateTopic,
    bindMapping,
    registerTopic: registerTopicLocal,
    loadTopic: loadExistingTopic,
    unloadTopic: unloadMapping,
    abortTurn: async (topicId) =>
      Boolean(await (opts.abortTurn?.(topicId, userId) ?? topicService.abortTurn(topicId, userId))),
  });

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
    if (privateDm) {
      bindMapping(chatId, threadId, personalGeneral.id);
    } else if (forumGroups.has(chatId) && threadId === undefined) {
      bindMapping(chatId, threadId, generalForGroup(chatId).id);
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
        void handleCommand(text, chatId, threadId, msg.from?.id);
      } else {
        mediaIntake.enqueue(chatId, threadId, () =>
          handleCommand(text, chatId, threadId, msg.from?.id),
        );
      }
      return;
    }
    if (hasMedia) {
      if (msg.media_group_id) {
        mediaIntake.bufferGroup(msg, chatId, threadId); // album item — one turn on flush
        return;
      }
      mediaIntake.enqueue(chatId, threadId, () => mediaIntake.handleMessage(msg, chatId, threadId));
      return;
    }
    if (!text) return;
    mediaIntake.enqueue(chatId, threadId, () =>
      runTurn(resolveMapping(chatId, threadId), text, chatId, threadId, msg),
    );
  }

  client.on("message", (msg: TelegramIncomingMessage) => {
    if (stopped) return;
    // Whitelist rejection is silent — same posture as clawgram (don't leak
    // the bot's existence to strangers) and no topic is ever created.
    if (!isAllowed(msg.from?.id)) return;

    if (msg.chat.type === "supergroup" && msg.chat.is_forum) {
      if (!forumGroups.get(msg.chat.id)?.manageTopicsAvailable) {
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
    if ((status === "left" || status === "kicked") && forumGroups.has(update.chat.id)) {
      void disconnectForum(update.chat.id).catch((err) =>
        logger.warn({ err, groupId: update.chat.id }, "telegram adapter: forum disconnect failed"),
      );
      return;
    }
    if (forumGroups.has(update.chat.id) && status !== "administrator" && status !== "creator") {
      const group = forumGroups.get(update.chat.id)!;
      group.permissionRevision += 1;
      const permissionWasAvailable = group.manageTopicsAvailable;
      group.manageTopicsAvailable = false;
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
      (!isAllowed(update.from.id) && !forumGroups.has(update.chat.id))
    ) {
      return;
    }
    void linkForumAndAnnounce(update.from.id, update.chat, update.new_chat_member!).catch((err) =>
      logger.warn({ err, groupId: update.chat.id }, "telegram adapter: forum auto-connect failed"),
    );
  });

  async function deliverPersistedRuntimeMessage(event: RuntimeBusEvent): Promise<boolean> {
    const msg = event.payload as MessageDto;
    const isTelegramOrigin =
      msg.sourceAdapter === "telegram" ||
      (msg.sourceAdapter === "runtime-gateway" && msg.sourceMessageId?.startsWith("telegram:"));
    if (msg.authorId === userId && isTelegramOrigin) return true;
    if (msg.kind === "tool") return true;
    const hasAttachments = Boolean(msg.attachments && msg.attachments.length > 0);
    if (!msg.text && !hasAttachments) return true;
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
    const tagFiles: OutboundFile[] = msg.text
      ? extractFileTagPaths(msg.text).map((path) => ({ path, filename: basename(path) }))
      : [];
    const attachmentFiles = hasAttachments
      ? (msg.attachments ?? [])
          .map((attachment): OutboundFile | null => {
            const path = resolveUploadedFilePathByFileId(attachment.id);
            if (!path) return null;
            return {
              path,
              filename: basename(attachment.filename) || basename(path),
              ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            };
          })
          .filter((file): file is OutboundFile => file !== null)
      : [];
    const files = [...tagFiles, ...attachmentFiles];
    const rawText = tagFiles.length > 0 && msg.text ? stripFileTags(msg.text) : (msg.text ?? "");
    const text = msg.authorId === userId && rawText ? `[From: User] ${rawText}` : rawText;
    if (!text && files.length === 0) return true;
    let settle!: (success: boolean) => void;
    const settled = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const payload: OutboundPayload = {
      text,
      files,
      runtimeMessageId,
      deliveryAckRequested: msg.deliveryAckRequested === true,
      onSettled: settle,
    };
    const routed = routeMessage(event.topicId, payload, msg.queryId);
    if (routed && payload.deliveryAckRequested) claimDeliveryAck(event.topicId, msg.id);
    return routed ? settled : true;
  }

  const savedRuntimeEventCursor = store.runtimeEventCursor();
  let runtimeEventCursor = savedRuntimeEventCursor ?? latestRuntimeEventSeq();
  if (savedRuntimeEventCursor === undefined) {
    store.advanceRuntimeEventCursor(runtimeEventCursor);
  }
  const runtimeEventConsumerId = `telegram:${userId}:${opts.mappingDbPath ?? "default"}`;
  heartbeatRuntimeEventConsumer(runtimeEventConsumerId, runtimeEventCursor);
  let pollingRuntimeEvents = false;
  let drainingRuntimeInbox = false;

  const drainRuntimeInbox = async (): Promise<void> => {
    if (drainingRuntimeInbox || stopped) return;
    drainingRuntimeInbox = true;
    try {
      while (!stopped) {
        const pending = store.pendingRuntimeEvents()[0];
        if (!pending) break;
        const delivered = await deliverPersistedRuntimeMessage(pending.event);
        if (!delivered || stopped) break;
        store.acknowledgeRuntimeEvent(pending.seq);
      }
    } catch (err) {
      if (!stopped) logger.warn({ err }, "telegram adapter: durable runtime inbox drain failed");
    } finally {
      drainingRuntimeInbox = false;
    }
  };

  const pollRuntimeEvents = (): void => {
    if (pollingRuntimeEvents || stopped) return;
    pollingRuntimeEvents = true;
    try {
      for (let batch = 0; batch < 5; batch += 1) {
        const events = listRuntimeEventsAfter(runtimeEventCursor, 500);
        if (events.length === 0) break;
        for (const event of events) {
          if (event.type === "message") store.captureRuntimeEvent({ ...event, seq: event.seq });
          else store.advanceRuntimeEventCursor(event.seq);
          runtimeEventCursor = event.seq;
        }
        if (events.length < 500) break;
      }
      void drainRuntimeInbox();
      heartbeatRuntimeEventConsumer(runtimeEventConsumerId, runtimeEventCursor);
    } finally {
      pollingRuntimeEvents = false;
    }
  };

  // ── outbound: RuntimeBus → Telegram ─────────────────────────────────
  const unsubscribe = runtimeBus().subscribe((event) => {
    if (stopped) return;
    if (event.type === "topic-created") {
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
      const status = event.payload as { kind?: string; queryId?: string; label?: string } | null;
      if (status?.kind === "ai_active" && typeof client.sendChatAction === "function") {
        if (status.queryId) startTypingHeartbeat(event.topicId, status.queryId);
        else sendTyping(event.topicId);
      }
      if (
        status?.queryId &&
        (status.kind === "ai_done" || status.kind === "ai_error" || status.kind === "ai_aborted")
      ) {
        closeToolStatus(status.queryId);
        stopTypingHeartbeat(status.queryId);
        targetByQueryId.delete(status.queryId);
        clearQueryDeliveryState(status.queryId);
      }
      if (status?.kind === "tool_call" && status.queryId && status.label) {
        showToolStatus(event.topicId, status.queryId, status.label);
      }
      return;
    }
    // Durable message delivery is driven by the ordered SQLite tail below.
    // The live bus remains responsible for ephemeral status and topic events.
  });

  pollRuntimeEvents();
  const runtimeEventPollTimer = setInterval(pollRuntimeEvents, 100);
  runtimeEventPollTimer.unref?.();

  for (const group of forumGroups.values()) {
    // Every connected forum owns an independent General manager and topic
    // namespace. Reconcile after subscribing so offline creations are not
    // missed between the startup snapshot and live events.
    bindMapping(group.chatId, undefined, generalForGroup(group.chatId).id);
    materializeVisibleTopics(group.chatId);
  }

  return {
    name: "telegram",
    loadTopic: loadExistingTopic,
    unloadTopic: unloadMapping,
    stop(): void {
      if (stopped) return;
      stopped = true;
      outboxWorker.stop();
      for (const timer of typingHeartbeatByQueryId.values()) clearInterval(timer);
      typingHeartbeatByQueryId.clear();
      for (const queryId of toolStatusByQueryId.keys()) closeToolStatus(queryId);
      mediaIntake.stop();
      clearInterval(runtimeEventPollTimer);
      unsubscribe();
      store.close();
    },
  };
}
