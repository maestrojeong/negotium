/**
 * Open Builder skill-server webhook.
 *
 * Mounted via core's `registerNodeRequestHandler` plugin chain (same
 * mechanism the doc comment in apps/negotium/../node/src/index.ts calls out
 * for "otium worker, future peers, webhooks" — plugins run before the
 * built-in MCP/health routes). This is the Negotium Node's public HTTP
 * surface; the operator is responsible for exposing it to the internet
 * (reverse proxy / tunnel) and pasting that URL into the Open Builder skill
 * server setting — this adapter only serves the route.
 */

import { randomUUID } from "node:crypto";
import type { TopicDto } from "@negotium/core";
import { appendApiMessage, logger, type MessageDto, runtimeBus, startAiTurn } from "@negotium/core";
import type { CallbackStore } from "@/callback-store";
import { collectBacklog, isTriggered, renderBacklogPrompt } from "@/trigger";
import { type KakaoSkillRequest, type KakaoSkillResponse, kakaoTextResponse } from "@/types";

export const KAKAOTALK_WEBHOOK_PATH = "/webhooks/kakaotalk";

/** Open Builder's own callback window is short; keep ours comfortably inside it. */
const CALLBACK_TTL_MS = 50_000;

export interface KakaoWebhookOptions {
  topic: () => TopicDto;
  userId: string;
  triggerWord: string;
  callbackStore: CallbackStore;
  /** "Thinking…" text shown while the real reply is produced asynchronously. */
  thinkingText?: string;
  /**
   * `userRequest.user.id` values allowed to reach this webhook. Empty/absent
   * means allow all — same "empty array = open" convention as the telegram
   * adapter's `allowedUsers`; the node-level wiring in packages/node never
   * reaches this with an empty array without an explicit
   * `NEGOTIUM_KAKAOTALK_ALLOW_ALL=true` (see src/env-auth.ts).
   *
   * Kakao's skill payload has no stable chat/room id (only `user.id`
   * reliably identifies the sender — devtalk.kakao.com/t/topic/133154), so
   * this is the only enforceable boundary: it rejects every sender other
   * than the allowlisted one(s), in any chat/room, including every other
   * participant of an open-chat room the bot is invited into.
   */
  allowedUsers?: readonly string[];
}

function json(body: KakaoSkillResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `{ version: "2.0", template: { outputs: [] } }` — a valid, silent ack for untriggered turns. */
function silentAck(): KakaoSkillResponse {
  return { version: "2.0", template: { outputs: [] } };
}

export function createKakaoWebhookHandler(opts: KakaoWebhookOptions) {
  return async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (url.pathname !== KAKAOTALK_WEBHOOK_PATH || req.method !== "POST") return null;

    let payload: KakaoSkillRequest;
    try {
      payload = (await req.json()) as KakaoSkillRequest;
    } catch {
      return json(kakaoTextResponse("invalid request"), 400);
    }

    const { utterance, user, callbackUrl } = payload.userRequest ?? {};
    if (!utterance || !user?.id) {
      return json(silentAck());
    }

    const allowed = opts.allowedUsers ?? [];
    if (allowed.length > 0 && !allowed.includes(user.id)) {
      // Rejection is silent and happens before anything is persisted or
      // touched — same posture as the telegram adapter's whitelist gate:
      // don't leak the bot's existence to a stranger, and don't let another
      // participant of an open-chat room the operator invited the bot into
      // ever land in the transcript or backlog. Logged (not silent on the
      // operator's side) so the very first real message from the operator's
      // own account can be used to discover the user.id to allowlist.
      logger.warn(
        { kakaoUserId: user.id },
        "kakaotalk adapter: rejected message from a non-allowlisted sender",
      );
      return json(silentAck());
    }

    const topic = opts.topic();

    // Persist every inbound message so the topic transcript is a real
    // record even when it doesn't trigger a turn — decision #2 relies on
    // this backlog existing for the NEXT trigger too.
    const message: MessageDto = {
      id: randomUUID(),
      topicId: topic.id,
      authorId: `kakao:${user.id}`,
      sourceAdapter: "kakaotalk",
      text: utterance,
      createdAt: new Date().toISOString(),
    };
    appendApiMessage(message);
    runtimeBus().broadcastMessage(topic.id, message);

    if (!isTriggered(utterance, opts.triggerWord)) {
      return json(silentAck());
    }

    if (!callbackUrl) {
      // Open Builder's callback option is off — the sync response IS the
      // only answer this request will ever get, so nothing async is
      // possible. Fall back to a minimal placeholder rather than silently
      // dropping a trigger the operator will not see land anywhere.
      return json(
        kakaoTextResponse(
          "콜백이 설정되어 있지 않아 바로 답하지 못해요. Open Builder 봇 설정에서 콜백을 켜주세요.",
        ),
      );
    }

    const requestId = randomUUID();
    opts.callbackStore.put({
      requestId,
      topicId: topic.id,
      callbackUrl,
      expiresAt: Date.now() + CALLBACK_TTL_MS,
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

    return json({
      version: "2.0",
      useCallback: true,
      data: { text: opts.thinkingText ?? "생각 중이에요..." },
    });
  };
}
