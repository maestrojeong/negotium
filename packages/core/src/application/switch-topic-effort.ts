import { getRegistry } from "#agents/registry";
import { WsHub } from "#bus";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import { getTopic } from "#storage/api-topics";
import type { EffortLevel } from "#types";

export type SwitchTopicEffortResult =
  | { ok: true; effort: EffortLevel; text: string }
  | { ok: false; error: string };

export interface SwitchTopicEffortParams {
  topicId: string;
  userId: string;
  effort: string;
}

/** Apply and user-lock one reasoning effort without resetting the topic session. */
export function switchTopicEffort(params: SwitchTopicEffortParams): SwitchTopicEffortResult {
  const topic = getTopic(params.topicId);
  if (!topic) return { ok: false, error: "Topic not found" };
  const owner = topic.participants.some(
    (participant) => participant.userId === params.userId && participant.role === "owner",
  );
  if (!owner) return { ok: false, error: "Only topic owners can change the effort" };
  if (!topic.agent) return { ok: false, error: "This topic has no AI effort" };

  const registry = getRegistry(topic.agent);
  const effort = registry.validEfforts.find((candidate) => candidate === params.effort);
  if (!effort) {
    return {
      ok: false,
      error: `Unknown effort: ${String(params.effort).trim() || "(empty)"}`,
    };
  }

  const currentConfig = getApiTopicConfig(topic.id) ?? {};
  setApiTopicConfig(topic.id, {
    ...currentConfig,
    effort,
    effortLocked: true,
  });
  WsHub.get().broadcastTopicUpdated(topic.id);
  return {
    ok: true,
    effort,
    text: `Effort set to '${effort}'. Applies from the next turn.`,
  };
}
