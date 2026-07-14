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
import type { TelegramClientLike, TelegramIncomingMessage } from "@/types";

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
}

/** Telegram caps forum topic names at 128 characters. */
const FORUM_TOPIC_NAME_MAX = 128;
/** DM fallback: how far up the parentTopicId chain to look for a mapped
 *  ancestor (spawn_subagent children can nest). */
const MAX_PARENT_HOPS = 5;
const DEFAULT_SEND_TIMEOUT_MS = 60_000;
/** Extensions delivered via sendPhoto (mirrors clawgram's IMAGE_EXTS). */
const PHOTO_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

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
  const titleFor = opts.topicTitleFor ?? defaultTopicTitle;
  const sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const footerEnabled = opts.footer === true;
  const dispatchTurn = opts.startTurn ?? startAiTurn;
  const forumMode = forumChatId !== undefined && typeof client.createForumTopic === "function";
  // forumMode implies forumChatId is a number — narrow it once here; every
  // forum-path use below is guarded by `forumMode`.
  const forumChat = forumChatId as number;
  if (forumChatId !== undefined && !forumMode) {
    logger.warn(
      { forumChatId },
      "telegram adapter: forumChatId set but client lacks createForumTopic — forum mode disabled",
    );
  }

  // ── mapping state ───────────────────────────────────────────────────
  // Two indexes over the same ChatMapping objects. byKey is 1:1 (a chat or
  // thread shows exactly one topic — UNIQUE(chat_id, thread_id) in the
  // store); byTopic fans out (a topic may render into several chats/threads,
  // e.g. a DM chat and a forum thread bound to the same room).
  const byKey = new Map<string, ChatMapping>(); // `${chatId}` | `${chatId}:${threadId}`
  const byTopic = new Map<string, Set<ChatMapping>>();
  const store = openMappingStore(opts.mappingDbPath);
  let stopped = false;

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
    try {
      for (const entry of store.outboxDue(Date.now())) {
        if (stopped) return;
        let sendErr: unknown;
        let sent = false;
        try {
          await client.sendMessage(entry.chatId, entry.html, {
            ...threadOpts(entry.threadId),
            parse_mode: "HTML",
          });
          sent = true;
        } catch (err) {
          sendErr = err;
          if (isHtmlParseError(telegramErrorInfo(err))) {
            try {
              await client.sendMessage(entry.chatId, entry.plain, threadOpts(entry.threadId));
              sent = true;
            } catch (plainErr) {
              sendErr = plainErr;
            }
          }
        }
        if (stopped) return; // store is (about to be) closed — leave the row for restart
        if (sent) {
          store.outboxDelete(entry.id);
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
      }
    } catch (err) {
      // Post-stop db access or unexpected store failure must not crash the host.
      if (!stopped) logger.warn({ err }, "telegram adapter: outbox flush failed");
    } finally {
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
  async function deliver(
    chatId: number,
    threadId: number | undefined,
    text: string,
  ): Promise<void> {
    const base = threadOpts(threadId);
    const htmlOpts = { ...base, parse_mode: "HTML" };
    for (const chunk of renderOutbound(text)) {
      try {
        await client.sendMessage(chatId, chunk.html, htmlOpts);
      } catch (err) {
        const info = telegramErrorInfo(err);
        if (isHtmlParseError(info)) {
          // Telegram rejected the HTML (e.g. markdown cut mid-chunk produced
          // invalid tags) — clawgram's fallback: resend the chunk as plain text.
          try {
            await client.sendMessage(chatId, chunk.plain, base);
          } catch (fallbackErr) {
            const fallbackInfo = telegramErrorInfo(fallbackErr);
            if (isRetryableSendError(fallbackInfo)) {
              enqueueOutbox(chatId, threadId, chunk.plain, chunk.plain, fallbackInfo);
            } else {
              logger.warn({ err: fallbackErr, chatId }, "telegram adapter: plain fallback failed");
            }
          }
          continue;
        }
        if (isRetryableSendError(info)) {
          enqueueOutbox(chatId, threadId, chunk.html, chunk.plain, info);
          continue;
        }
        logger.warn({ err, chatId }, "telegram adapter: send failed — dropping chunk");
      }
    }
  }

  /** Send one produced file (from a [FILE:] tag): photos by extension via
   *  sendPhoto, everything else via sendDocument; sensitive paths blocked;
   *  missing files surface as a plain-text notice (model intent was explicit). */
  async function sendFile(
    chatId: number,
    threadId: number | undefined,
    path: string,
  ): Promise<void> {
    const base = threadOpts(threadId);
    if (isSensitivePath(path)) {
      logger.warn({ path, chatId }, "telegram adapter: blocked sensitive file path");
      return;
    }
    if (!existsSync(path)) {
      await client.sendMessage(chatId, `File: ${path}`, base).catch(() => {});
      return;
    }
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    try {
      if (PHOTO_EXTS.has(ext) && typeof client.sendPhoto === "function") {
        await client.sendPhoto(chatId, path, base);
      } else if (typeof client.sendDocument === "function") {
        await client.sendDocument(chatId, path, base);
      } else {
        // Client has no file surface — at least point the user at the path.
        await client.sendMessage(chatId, `File: ${path}`, base);
      }
    } catch (err) {
      logger.warn({ err, path, chatId }, "telegram adapter: file send failed");
    }
  }

  async function deliverPayload(
    chatId: number,
    threadId: number | undefined,
    payload: OutboundPayload,
  ): Promise<void> {
    if (payload.text) await deliver(chatId, threadId, payload.text);
    for (const path of payload.files) await sendFile(chatId, threadId, path);
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

  // ── forum mode: materialize runtime topics as forum threads ─────────
  /** One in-flight `createForumTopic`: messages arriving meanwhile are
   *  buffered (flushed in order once the thread exists); `cancelled` is set
   *  by topic-deleted so the continuation discards the orphan thread. */
  interface PendingMaterialization {
    buffer: OutboundPayload[];
    cancelled: boolean;
  }
  const pendingByTopic = new Map<string, PendingMaterialization>();
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
      suppressMaterialize > 0 ||
      byTopic.has(topic.id) ||
      pendingByTopic.has(topic.id) ||
      materializeTombstones.has(topic.id)
    ) {
      return;
    }
    if (!isTopicVisible(topic)) return;
    // Only rooms the adapter's (single) negotium user can see.
    if (!topic.participants?.some((p) => p.userId === userId)) return;
    const pending: PendingMaterialization = { buffer: [], cancelled: false };
    pendingByTopic.set(topic.id, pending);
    void (async () => {
      let created: { message_thread_id: number };
      try {
        // forumMode implies createForumTopic exists (checked at start).
        created = await client.createForumTopic!(
          forumChat,
          topic.title.slice(0, FORUM_TOPIC_NAME_MAX),
        );
      } catch (err) {
        pendingByTopic.delete(topic.id);
        // Adapter stopped or topic deleted while the call was in flight —
        // not a creation failure; don't tombstone (store may be closed).
        if (stopped || pending.cancelled) return;
        logger.warn(
          { err, topicId: topic.id, title: topic.title },
          "telegram adapter: createForumTopic failed — falling back to general chat",
        );
        materializeTombstones.set(topic.id, topic.title);
        store.saveTombstone(topic.id, topic.title);
        flushBuffered(topic.id, pending.buffer, (payload) => deliverFallback(topic.title, payload));
        return;
      }
      pendingByTopic.delete(topic.id);
      const threadId = created.message_thread_id;
      if (stopped || pending.cancelled) {
        // Cancelled = the topic was deleted while creation was in flight:
        // drop the just-created orphan thread (best-effort) and bind nothing.
        // Stopped = abandon silently (no post-stop sends, no closed-DB save).
        if (pending.cancelled && typeof client.deleteForumTopic === "function") {
          void client
            .deleteForumTopic(forumChat, threadId)
            .catch((err) =>
              logger.warn(
                { err, topicId: topic.id, threadId },
                "telegram adapter: orphan thread cleanup failed",
              ),
            );
        }
        return;
      }
      bindMapping(forumChat, threadId, topic.id);
      flushBuffered(topic.id, pending.buffer, (payload) =>
        deliverPayload(forumChat, threadId, payload),
      );
    })();
  }

  function handleTopicDeleted(topicId: string): void {
    if (materializeTombstones.delete(topicId)) store.deleteTombstone(topicId);
    const pending = pendingByTopic.get(topicId);
    if (pending) pending.cancelled = true; // in-flight creation — its continuation cleans up
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

  function routeMessage(topicId: string, payload: OutboundPayload): void {
    const pending = pendingByTopic.get(topicId);
    if (pending) {
      pending.buffer.push(payload); // thread creation in flight — flushed in order later
      return;
    }
    const mappings = byTopic.get(topicId);
    if (mappings && mappings.size > 0) {
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
      });
    }
  }

  // ── inbound: Telegram → runtime ─────────────────────────────────────
  /** Fire-and-forget plain-text reply (command feedback, error notices). */
  function reply(chatId: number, threadId: number | undefined, text: string): void {
    void client
      .sendMessage(chatId, text, threadOpts(threadId))
      .catch((err) => logger.warn({ err, chatId }, "telegram adapter: reply failed"));
  }

  /** Persist the user message and start the AI turn (single fixed userId). */
  function runTurn(topic: TopicDto, prompt: string): void {
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: userId,
      text: prompt,
      createdAt: new Date().toISOString(),
    });
    dispatchTurn({ topic, userId, prompt, allowAutoContinue: true });
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
      if (caption) runTurn(topic, caption);
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
    runTurn(topic, composeAttachmentPrompt(userText, promptLines));
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
      if (captions.length > 0) runTurn(topic, captions.join("\n"));
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
    runTurn(topic, composeAttachmentPrompt(userText, promptLines));
  }

  // ── commands ────────────────────────────────────────────────────────
  /** Handle a leading-slash command. Commands never start an AI turn. */
  function handleCommand(text: string, chatId: number, threadId?: number): void {
    const [rawCmd = ""] = text.split(/\s+/);
    const cmd = rawCmd.replace(/@\w+$/, ""); // tolerate "/abort@MyBot" in groups
    const arg = extractCommandArg(text);
    switch (cmd) {
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
          reply(chatId, threadId, "usage: /new <name>");
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
          "commands: /new <name>, /topics, /agent <claude|codex|maestro>, " +
            "/load <topic>, /unload, /fork [name], /spawn [name], " +
            "/del [name], /del! [name], /abort",
        );
    }
  }

  client.on("message", (msg: TelegramIncomingMessage) => {
    if (stopped) return;
    // Whitelist rejection is silent — same posture as clawgram (don't leak
    // the bot's existence to strangers) and no topic is ever created.
    if (allowed.size > 0 && !allowed.has(String(msg.from?.id))) return;
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const text = msg.text?.trim();
    const hasMedia = Boolean(msg.photo?.length || msg.document || msg.voice);

    if (text?.startsWith("/")) {
      // Abort is an out-of-band control and must not wait behind a slow file
      // download. Other commands participate in arrival ordering because they
      // can change the chat's topic mapping.
      const command = text.split(/\s+/, 1)[0]?.replace(/@\w+$/, "");
      if (command === "/abort") {
        handleCommand(text, chatId, threadId);
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
    enqueueInbound(chatId, threadId, () => runTurn(resolveMapping(chatId, threadId), text));
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
    if (event.type === "ai-status") {
      // Turn started → best-effort typing indicator in every bound chat.
      const status = event.payload as { kind?: string } | null;
      if (status?.kind === "ai_active" && typeof client.sendChatAction === "function") {
        for (const mapping of byTopic.get(event.topicId) ?? []) {
          void client
            .sendChatAction(mapping.chatId, "typing", threadOpts(mapping.threadId))
            .catch(() => {});
        }
      }
      return;
    }
    if (event.type !== "message") return;
    const msg = event.payload as MessageDto;
    if (msg.authorId === userId) return; // echo of the user's own inbound message
    if (msg.kind === "tool") return; // tool chatter stays off the chat
    if (!msg.text) return;
    // Produced files ride as real attachments; the raw [FILE:] tags are noise.
    const files = extractFileTagPaths(msg.text);
    let text = files.length > 0 ? stripFileTags(msg.text) : msg.text;
    if (footerEnabled && msg.authorId === "ai") {
      const footer = renderTurnFooter(msg);
      // Single-asterisk markdown renders as <i> — Telegram's "dim" line.
      if (footer) text = text ? `${text}\n\n*${footer}*` : `*${footer}*`;
    }
    if (!text && files.length === 0) return;
    routeMessage(event.topicId, { text, files });
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
