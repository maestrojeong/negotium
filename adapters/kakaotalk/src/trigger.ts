/**
 * Trigger detection + backlog construction for the kakaotalk topic.
 *
 * Decision #2: the kakaotalk topic does NOT use core's `aiMode: "mention"` —
 * KakaoTalk has no platform-level @mention syntax to hook into. Instead this
 * adapter does its own substring match against the configured trigger word
 * (the node's assistant name) directly on inbound text.
 *
 * When a trigger fires, the turn's prompt is not just the one triggering
 * message: it is every kakaotalk-sourced message recorded since this topic's
 * last AI reply, newest message last, so the model can follow a multi-message
 * back-and-forth instead of reacting to one line in isolation. If that
 * backlog is too large, the OLDEST messages are dropped first — the tail
 * (most recent messages, ending at the trigger) is always kept intact.
 */

import { listApiMessages, type MessageDto } from "@negotium/core";

/** Characters budget for the concatenated backlog before truncating the head. */
const DEFAULT_MAX_BACKLOG_CHARS = 12_000;
/** How far back to look for the last AI reply before giving up and using everything fetched. */
const BACKLOG_FETCH_LIMIT = 200;

export function isTriggered(text: string, triggerWord: string): boolean {
  if (!triggerWord.trim()) return false;
  return text.toLowerCase().includes(triggerWord.trim().toLowerCase());
}

/** A message counts as the bot's own reply if core stamped it with an agentType. */
function isAiReply(message: MessageDto): boolean {
  return Boolean(message.agentType);
}

export interface BacklogMessage {
  authorName: string;
  text: string;
  createdAt: string;
}

/**
 * Messages recorded in this topic since the last AI reply, oldest-first,
 * including the message that just triggered the turn.
 */
export function collectBacklog(topicId: string): MessageDto[] {
  const { page } = listApiMessages(topicId, { limit: BACKLOG_FETCH_LIMIT });
  let sinceIndex = 0;
  for (let i = page.length - 1; i >= 0; i--) {
    if (isAiReply(page[i])) {
      sinceIndex = i + 1;
      break;
    }
  }
  return page.slice(sinceIndex);
}

/**
 * Render the backlog into one turn prompt. Drops the oldest lines first when
 * over budget, so the trigger message and the surrounding recent context
 * always survive truncation.
 */
export function renderBacklogPrompt(
  backlog: readonly BacklogMessage[],
  maxChars = DEFAULT_MAX_BACKLOG_CHARS,
): string {
  const lines = backlog.map((m) => `${m.authorName}: ${m.text}`);
  let body = lines.join("\n");
  while (body.length > maxChars && lines.length > 1) {
    lines.shift();
    body = lines.join("\n");
  }
  return [
    "다음은 KakaoTalk 채팅방에서 네가 마지막으로 답한 이후 쌓인 메시지들이다.",
    "이건 대화 맥락일 뿐이니, 가장 최근에 너에게 직접 묻거나 말을 건 내용에 초점을 맞춰 적절히 답장해.",
    "",
    body,
  ].join("\n");
}
