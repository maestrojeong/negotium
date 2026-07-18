import { getTopic, isTopicShared, isTopicVisible, upsertTopic, WsHub } from "@negotium/core";
import {
  bindPeerSession,
  getPeerSession,
  listPeerSessions,
  unbindPeerSession,
  unbindSharedPeerSessionsForLocalTopic,
} from "@/store";

export type OtiumTopicBindingResult =
  | { ok: true; localTopicId: string; replaced: boolean }
  | { ok: false; error: string; status: number };

export interface OtiumTopicBinding {
  hostNodeId: string;
  hostTopicId: string;
  localTopicId: string;
  /** Internal Otium transport; this is deliberately not a topic access mode. */
  transport: "internal-mirror" | "shared-binding";
  topicAccessMode?: "private" | "shared";
  localTopicTitle?: string;
  localTopicExists: boolean;
  createdAt: string;
}

export type OtiumTopicPrivateResult =
  | { ok: true; localTopicId: string; removedBindings: number }
  | { ok: false; error: string; status: number };

function ownsTopic(localTopicId: string, userId: string) {
  const topic = getTopic(localTopicId);
  if (!topic) return { ok: false as const, error: "local topic not found", status: 404 };
  if (!isTopicVisible(topic)) {
    return { ok: false as const, error: "internal topics have no user access mode", status: 409 };
  }
  if (!topic.participants.some((participant) => participant.userId === userId)) {
    return { ok: false as const, error: "local topic is not visible to this user", status: 403 };
  }
  if (
    !topic.participants.some(
      (participant) => participant.userId === userId && participant.role === "owner",
    )
  ) {
    return {
      ok: false as const,
      error: "only a topic owner can change its access mode",
      status: 403,
    };
  }
  return { ok: true as const, topic };
}

/** Bind an Otium room to an existing visible Negotium topic without cloning it. */
export function bindOtiumTopic(options: {
  hostNodeId: string;
  hostTopicId: string;
  localTopicId: string;
  userId: string;
}): OtiumTopicBindingResult {
  const topic = getTopic(options.localTopicId);
  if (!topic) return { ok: false, error: "local topic not found", status: 404 };
  if (!isTopicVisible(topic)) {
    return { ok: false, error: "hidden local topics cannot be shared", status: 409 };
  }
  if (!topic.participants.some((participant) => participant.userId === options.userId)) {
    return { ok: false, error: "local topic is not visible to this user", status: 403 };
  }
  if (!isTopicShared(topic)) {
    return { ok: false, error: "private topics must be shared explicitly first", status: 409 };
  }
  const previous = getPeerSession(options.hostNodeId, options.hostTopicId);
  bindPeerSession(options.hostNodeId, options.hostTopicId, options.localTopicId, "shared");
  return {
    ok: true,
    localTopicId: options.localTopicId,
    replaced: Boolean(previous && previous.local_topic_id !== options.localTopicId),
  };
}

/** Explicitly publish a private local topic and bind one Otium room to it. */
export function shareOtiumTopic(options: {
  hostNodeId: string;
  hostTopicId: string;
  localTopicId: string;
  userId: string;
}): OtiumTopicBindingResult {
  const owned = ownsTopic(options.localTopicId, options.userId);
  if (!owned.ok) return owned;
  if (!isTopicShared(owned.topic)) {
    upsertTopic({ ...owned.topic, accessMode: "shared" });
    WsHub.get().broadcastTopicUpdated(owned.topic.id);
  }
  return bindOtiumTopic(options);
}

/** Make a user topic local-only and remove all of its Otium room bindings. */
export function setOtiumTopicPrivate(options: {
  localTopicId: string;
  userId: string;
}): OtiumTopicPrivateResult {
  const owned = ownsTopic(options.localTopicId, options.userId);
  if (!owned.ok) return owned;
  const removedBindings = unbindSharedPeerSessionsForLocalTopic(options.localTopicId);
  if (isTopicShared(owned.topic)) {
    upsertTopic({ ...owned.topic, accessMode: "private" });
    WsHub.get().broadcastTopicUpdated(owned.topic.id);
  }
  return { ok: true, localTopicId: options.localTopicId, removedBindings };
}

/** Remove only the Otium binding. The local Negotium topic is never deleted. */
export function unbindOtiumTopic(hostNodeId: string, hostTopicId: string): boolean {
  return unbindPeerSession(hostNodeId, hostTopicId);
}

/** Inspect internal execution mirrors and user-topic shared bindings. */
export function listOtiumTopicBindings(): OtiumTopicBinding[] {
  return listPeerSessions().map((row) => {
    const topic = getTopic(row.local_topic_id);
    return {
      hostNodeId: row.host_node_id,
      hostTopicId: row.host_topic_id,
      localTopicId: row.local_topic_id,
      transport: row.binding_mode === "shared" ? "shared-binding" : "internal-mirror",
      ...(topic ? { topicAccessMode: topic.accessMode ?? "private" } : {}),
      ...(topic ? { localTopicTitle: topic.title } : {}),
      localTopicExists: Boolean(topic),
      createdAt: row.created_at,
    };
  });
}
