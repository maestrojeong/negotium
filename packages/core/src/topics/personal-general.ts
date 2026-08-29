import { randomUUID } from "node:crypto";
import { getRegistry } from "#agents/registry";
import { resolveDefaultModel } from "#platform/config";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import {
  defaultSurfaceScope,
  defaultTopicSurface,
  getManagerTopicForUser,
  getTopic,
  normalizeSurfaceScope,
  normalizeTopicSurface,
  upsertTopic,
} from "#storage/api-topics";
import type { TopicDto, TopicSurface } from "#types/api";

const LEGACY_PERSONAL_GENERAL_DESCRIPTION =
  "나만의 개인 공간이에요. 대화와 AI 작업은 다른 사용자에게 공개되지 않습니다.";
export const PERSONAL_GENERAL_DESCRIPTION =
  "Your private General. Messages and membership are visible only to you. Workspace memory, wiki, and skills are shared with your workspace.";

/**
 * Return the caller's private General room, creating it on first use.
 *
 * The legacy `general` row is deliberately excluded: it was shared by every
 * user and remains untouched for an explicit, operator-controlled migration.
 */
export function ensurePersonalGeneral(
  userId: string,
  surface?: TopicSurface,
  opts: { surfaceScope?: string | null } = {},
): TopicDto {
  const scope = normalizeTopicSurface(surface ?? defaultTopicSurface());
  // One General per user *per surface namespace*. Otium namespaces by
  // workspace and Telegram by forum group; sharing one manager across either
  // boundary would merge unrelated transcripts and provider sessions.
  const surfaceScope =
    opts.surfaceScope !== undefined
      ? normalizeSurfaceScope(opts.surfaceScope)
      : scope === "otium"
        ? defaultSurfaceScope()
        : null;
  const existing = getManagerTopicForUser(userId, scope, { surfaceScope });
  if (existing) {
    if (existing.description === LEGACY_PERSONAL_GENERAL_DESCRIPTION) {
      existing.description = PERSONAL_GENERAL_DESCRIPTION;
      upsertTopic(existing);
    }
    if (!getApiTopicConfig(existing.id)) {
      setApiTopicConfig(existing.id, { model: "deepseek-pro", modelLocked: true });
    }
    return existing;
  }

  const now = new Date().toISOString();
  const registry = getRegistry("maestro");
  const topic: TopicDto = {
    id: randomUUID(),
    title: "General",
    description: PERSONAL_GENERAL_DESCRIPTION,
    kind: "manager",
    agent: "maestro",
    defaultModel: resolveDefaultModel("maestro", registry.defaultModel),
    defaultEffort: registry.defaultEffort ?? "medium",
    aiMode: "always",
    aiMention: false,
    participants: [{ userId, role: "owner" }],
    surface: scope,
    surfaceScope,
    createdAt: now,
    lastMessageAt: now,
  };
  upsertTopic(topic);
  setApiTopicConfig(topic.id, { model: "deepseek-pro", modelLocked: true });
  return topic;
}

/** Resolve the retired fixed id for old clients without exposing the shared row. */
export function resolvePersonalTopicId(topicId: string, userId: string): string {
  return topicId === GENERAL_TOPIC_ID ? ensurePersonalGeneral(userId).id : topicId;
}

export function isManagerTopic(topicId: string): boolean {
  return getTopic(topicId)?.kind === "manager";
}

export function isLegacySharedGeneral(topicId: string): boolean {
  return topicId === GENERAL_TOPIC_ID;
}
