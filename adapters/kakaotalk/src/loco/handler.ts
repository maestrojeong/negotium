/**
 * LOCO transport's per-message pipeline — the sibling of ../webhook.ts for
 * the Open Builder transport. Same shape (allowlist gate → persist →
 * trigger check → store reply target → backlog → startAiTurn), adapted to
 * LOCO's push-event model instead of a request/response webhook.
 */

import { randomUUID } from "node:crypto";
import {
  appendApiMessage,
  logger,
  type MessageDto,
  runtimeBus,
  startAiTurn,
  type TopicDto,
} from "@negotium/core";
import type { LocoMessageEvent } from "@/loco/bridge";
import { isLocoSenderAllowed, type KakaoTalkLocoConfig } from "@/loco/env-auth";
import type { LocoReplyStore } from "@/loco/reply-store";
import { collectBacklog, isTriggered, renderBacklogPrompt } from "@/trigger";

/** No Open-Builder-style artificial callback window, but a stale reply target answering an unrelated turn would still be a bug. */
const REPLY_TARGET_TTL_MS = 10 * 60_000;

export interface LocoMessageHandlerOptions {
  topic: () => TopicDto;
  userId: string;
  triggerWord: string;
  config: Extract<KakaoTalkLocoConfig, { enabled: true }>;
  replyStore: LocoReplyStore;
}

export function createLocoMessageHandler(opts: LocoMessageHandlerOptions) {
  return function handle(event: LocoMessageEvent): void {
    if (!isLocoSenderAllowed(opts.config, event.authorId, event.chatId)) {
      // Same posture as the Open Builder gate (../webhook.ts): reject before
      // anything is persisted or touched, log the rejected ids so the
      // operator can see what to add if it was actually them/a room they meant
      // to allow.
      logger.warn(
        { locoUserId: event.authorId, locoChatId: event.chatId },
        "kakaotalk adapter: rejected LOCO message from a non-allowlisted sender/room",
      );
      return;
    }

    const topic = opts.topic();
    const message: MessageDto = {
      id: randomUUID(),
      topicId: topic.id,
      authorId: `kakao-loco:${event.authorId}`,
      sourceAdapter: "kakaotalk",
      // Room name/type kept in the text itself (not just metadata) since the
      // single shared "kakaotalk" topic (decision A) otherwise gives the
      // model no way to tell which of possibly several rooms a line came
      // from — it needs that to answer sensibly across rooms.
      text: `[${event.roomName} · ${event.roomType}] ${event.authorName}: ${event.text}`,
      createdAt: new Date(event.sendAt * 1000 || Date.now()).toISOString(),
    };
    appendApiMessage(message);
    runtimeBus().broadcastMessage(topic.id, message);

    if (!isTriggered(event.text, opts.triggerWord)) return;

    opts.replyStore.put({
      requestId: randomUUID(),
      topicId: topic.id,
      chatId: event.chatId,
      expiresAt: Date.now() + REPLY_TARGET_TTL_MS,
    });

    const backlog = collectBacklog(topic.id).map((m) => ({
      authorName: m.authorId,
      text: m.text,
      createdAt: m.createdAt,
    }));
    const prompt = renderBacklogPrompt(backlog);

    startAiTurn({
      topic,
      userId: opts.userId,
      prompt,
      allowAutoContinue: true,
    });
  };
}
