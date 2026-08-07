import { WsHub } from "#bus";
import { getTopic, listTopics, setTopicAccessModes } from "#storage/api-topics";
import type { TopicAccessMode, TopicDto } from "#types/api";

export type SwitchTopicAccessModeResult =
  | { ok: true; accessMode: TopicAccessMode; text: string; topicIds: string[] }
  | { ok: false; error: string };

export interface SwitchTopicAccessModeParams {
  topicId: string;
  userId: string;
  accessMode: TopicAccessMode;
}

/**
 * Every subagent room reachable from `rootTopicId`, deepest-first order aside.
 *
 * Mirrors the traversal `deleteTopicCascade` already uses: only `isSubagent`
 * children are owned by their parent, while fork/spawn rooms are independent
 * and must keep their own privacy. `seen` guards against a parent cycle left
 * behind by reparenting, which would otherwise loop forever.
 */
function collectSubagentDescendants(rootTopicId: string): TopicDto[] {
  const all = listTopics();
  const childrenByParent = new Map<string, TopicDto[]>();
  for (const topic of all) {
    if (!topic.isSubagent || !topic.parentTopicId) continue;
    const siblings = childrenByParent.get(topic.parentTopicId);
    if (siblings) siblings.push(topic);
    else childrenByParent.set(topic.parentTopicId, [topic]);
  }
  const descendants: TopicDto[] = [];
  const seen = new Set<string>([rootTopicId]);
  const queue = [rootTopicId];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return descendants;
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
  // A subagent room is owned by the room that spawned it, so its privacy is not
  // its own to change: allowing it would let a worker room escape the parent's
  // setting, and the next parent switch would silently overwrite it anyway.
  if (topic.isSubagent) {
    return {
      ok: false,
      error: "Subagent rooms inherit privacy from their parent topic",
    };
  }

  // Subagents hold the parent's conversation context, so leaving them behind on
  // the old mode would either expose work the user just made private or strand
  // half a delegation tree off the Hub. New rooms already inherit the parent's
  // access mode at creation (`createDerivedTopic`); this keeps existing ones in
  // step.
  const descendants = collectSubagentDescendants(topic.id);
  const changed = [topic, ...descendants].filter(
    (candidate) => (candidate.accessMode ?? "private") !== params.accessMode,
  );
  if (changed.length === 0) {
    return {
      ok: true,
      accessMode: params.accessMode,
      text:
        params.accessMode === "shared"
          ? `"${topic.title}" is already public to the connected Otium Hub.`
          : `"${topic.title}" is already private to this worker.`,
      topicIds: [],
    };
  }

  setTopicAccessModes(
    changed.map((candidate) => candidate.id),
    params.accessMode,
  );
  // Broadcast only after the write commits: an event emitted inside the
  // transaction would announce a state a rollback could still take back.
  for (const candidate of changed) WsHub.get().broadcastTopicUpdated(candidate.id);

  const subagentCount = changed.filter((candidate) => candidate.id !== topic.id).length;
  const suffix =
    subagentCount > 0
      ? ` (${subagentCount} subagent room${subagentCount === 1 ? "" : "s"} updated)`
      : "";
  return {
    ok: true,
    accessMode: params.accessMode,
    topicIds: changed.map((candidate) => candidate.id),
    text:
      (params.accessMode === "shared"
        ? `"${topic.title}" is public to the connected Otium Hub.`
        : `"${topic.title}" is private to this worker.`) + suffix,
  };
}
