import { WsHub } from "#bus";
import { getTopic, upsertTopic } from "#storage/api-topics";
import type { TopicAccessMode } from "#types/api";

export type SwitchTopicAccessModeResult =
  | { ok: true; accessMode: TopicAccessMode; text: string }
  | { ok: false; error: string };

export interface SwitchTopicAccessModeParams {
  topicId: string;
  userId: string;
  accessMode: TopicAccessMode;
}

/** Change whether a user-owned topic is local-only or shared with connected adapters. */
export function switchTopicAccessMode(
  params: SwitchTopicAccessModeParams,
): SwitchTopicAccessModeResult {
  const topic = getTopic(params.topicId);
  if (!topic) return { ok: false, error: "Topic not found" };
  const owner = topic.participants.some(
    (participant) => participant.userId === params.userId && participant.role === "owner",
  );
  if (!owner) return { ok: false, error: "Only topic owners can change privacy" };

  topic.accessMode = params.accessMode;
  upsertTopic(topic);
  WsHub.get().broadcastTopicUpdated(topic.id);
  return {
    ok: true,
    accessMode: params.accessMode,
    text:
      params.accessMode === "shared"
        ? `"${topic.title}" is public to the connected Otium Hub.`
        : `"${topic.title}" is private to this worker.`,
  };
}
