/**
 * The single persistent "kakaotalk" manager topic.
 *
 * Unlike the telegram adapter (one negotium topic per chat/thread), the
 * kakaotalk surface is ONE node-wide topic: all KakaoTalk channel activity
 * funnels through it. It reuses core's manager-topic mechanism so it gets
 * the same guarantees the per-user "General" room gets for free —
 * - `kind: "manager"` is protected from deletion (topics/lifecycle.ts
 *   refuses to delete a manager topic unless `allowManager` is passed),
 * - the terminal picker sorts `kind === "manager"` topics into their own
 *   section at the top (adapters/terminal/src/state.ts topicPickerItems).
 *
 * `ensurePersonalGeneral` already implements "one manager topic per
 * (userId, surface), create on first use, reuse after" — exactly the
 * lifecycle this needs. The only difference from a real General room is the
 * title, which this function pins to "kakaotalk" instead of "General".
 */

import { ensurePersonalGeneral, type TopicDto, updateTopic } from "@negotium/core";

const KAKAOTALK_TOPIC_TITLE = "kakaotalk";

export function ensureKakaoTalkTopic(userId: string): TopicDto {
  const topic = ensurePersonalGeneral(userId, "kakaotalk");
  if (topic.title !== KAKAOTALK_TOPIC_TITLE) {
    updateTopic(topic.id, { title: KAKAOTALK_TOPIC_TITLE });
    topic.title = KAKAOTALK_TOPIC_TITLE;
  }
  return topic;
}
