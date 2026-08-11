/**
 * Programmatic topic settings update — the mutating counterpart to
 * `registerTopic`. Every surface that changes a room's title, backend, model,
 * effort or AI mode goes through this one function so validation, state
 * normalization and the update broadcast never fork.
 *
 * It exists because a host that only mirrors rooms (Otium) had no way to write
 * these fields back: the turn runner resolves execution from the *node's* own
 * `topic.agent` / `defaultModel` / `defaultEffort`, so a picker on the host was
 * cosmetic until the node's row changed too (D-1).
 */

import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { WsHub } from "#bus";
import { RESERVED_TOPIC_NAMES } from "#platform/constants";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import {
  findTopicTitleConflict,
  getTopic,
  normalizeAiMode,
  normalizeTopicKind,
  normalizeTopicState,
  upsertTopic,
} from "#storage/api-topics";
import { TopicValidationError } from "#topics/create";
import { type AgentKind, type EffortLevel, isAgentKind } from "#types";
import type { AiMode, TopicDto } from "#types/api";

/**
 * Absent means "leave alone"; `agent: null` means "remove the AI". The two are
 * different requests and a caller that only wants to rename a room must not
 * have its backend reset as a side effect, so every field is optional and
 * `null` is reserved for the one field where clearing is meaningful.
 */
export interface UpdateTopicSettingsOptions {
  topicId: string;
  title?: string;
  agent?: AgentKind | null;
  defaultModel?: string;
  defaultEffort?: string;
  aiMode?: AiMode;
}

/** A title that is already taken by another room on the same surface. */
export class TopicUpdateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicUpdateConflictError";
  }
}

/**
 * Apply a partial settings change to an existing topic.
 *
 * Throws {@link TopicValidationError} on bad input and
 * {@link TopicUpdateConflictError} on a duplicate title. Returns the stored
 * topic as it now reads, which is what callers echo back.
 */
export function updateTopicSettings(opts: UpdateTopicSettingsOptions): TopicDto {
  const current = getTopic(opts.topicId);
  if (!current) throw new TopicValidationError("Topic not found");
  if (current.kind === "manager") {
    // Manager rooms are system-managed: their title is the user's identity in
    // the personal-General namespace and their agent is not user-selectable.
    throw new TopicValidationError("Manager rooms are system-managed");
  }

  let title = current.title;
  if (opts.title !== undefined) {
    title = opts.title.trim();
    if (!title) throw new TopicValidationError("title is required");
    if (RESERVED_TOPIC_NAMES.has(title.toLowerCase())) {
      throw new TopicValidationError(`"${title}" is a reserved name`);
    }
  }

  if (opts.agent !== undefined && opts.agent !== null && !isAgentKind(opts.agent)) {
    throw new TopicValidationError(`Unknown agent '${opts.agent}'`);
  }
  const requestedAgent: AgentKind | undefined =
    opts.agent === undefined ? current.agent : (opts.agent ?? undefined);

  // The kind is derived, never sent: an agent room is "always", a channel is
  // "mention"/"off". Feeding both through `normalizeTopicState` is what stops a
  // caller from writing e.g. `aiMode: "off"` onto a room that still claims an
  // agent, which the turn runner would read as an AI room that never answers.
  const requestedAiMode = opts.aiMode ?? current.aiMode;
  const requestedKind =
    opts.agent === null || requestedAiMode === "off" || requestedAiMode === "mention"
      ? "channel"
      : normalizeTopicKind(current.kind);
  const { kind, aiMode, agent } = normalizeTopicState({
    id: current.id,
    kind: requestedKind,
    agent: requestedAgent,
    aiMode: normalizeAiMode(requestedAiMode),
  });

  // Titles are unique per surface instance, so the conflict check must run on
  // the row's own surface rather than this process's default (M-1).
  if (title.toLowerCase() !== current.title.toLowerCase() || kind !== current.kind) {
    const conflict = findTopicTitleConflict(title, kind, {
      excludeTopicId: current.id,
      surface: current.surface,
      surfaceScope: current.surfaceScope ?? null,
    });
    if (conflict) {
      throw new TopicUpdateConflictError(
        `A topic named "${title}" already exists on ${current.surface ?? "this surface"}`,
      );
    }
  }

  const registry = getRegistry(agent ?? "maestro");
  if (opts.defaultModel !== undefined) {
    if (!agent) throw new TopicValidationError("This topic has no AI model");
    if (!registry.validateModel(opts.defaultModel)) {
      throw new TopicValidationError(
        `model '${opts.defaultModel}' is not valid for agent '${agent}'`,
      );
    }
  }
  if (opts.defaultEffort !== undefined) {
    if (!agent) throw new TopicValidationError("This topic has no AI effort");
    if (!registry.validateEffort(opts.defaultEffort as EffortLevel)) {
      throw new TopicValidationError(
        `effort '${opts.defaultEffort}' is not valid for agent '${agent}'`,
      );
    }
  }

  // A model carried over from the previous backend is not selectable on the new
  // one, so `resolveModelForAgent` falls back rather than persisting a token the
  // registry will reject on the next turn.
  const defaultModel = resolveModelForAgent(
    agent ?? "maestro",
    opts.defaultModel ?? (agent === current.agent ? current.defaultModel : undefined),
    registry,
  );
  const requestedEffort = (opts.defaultEffort ??
    (agent === current.agent ? current.defaultEffort : undefined)) as EffortLevel | undefined;
  const defaultEffort =
    requestedEffort && registry.validateEffort(requestedEffort)
      ? requestedEffort
      : (registry.defaultEffort ?? "medium");

  const next: TopicDto = {
    ...current,
    title,
    kind,
    aiMode,
    agent,
    defaultModel,
    defaultEffort,
  };
  upsertTopic(next);

  // `resolveTopicTurnExecution` reads `config.model ?? topic.defaultModel`, so a
  // stale per-topic override (set earlier by `/model` in the terminal) would
  // silently shadow the value we just wrote and make this update look ignored —
  // exactly the bug this route exists to fix. Clear only the fields the caller
  // actually changed, so an untouched override survives.
  const config = getApiTopicConfig(next.id);
  if (config && (opts.defaultModel !== undefined || opts.defaultEffort !== undefined)) {
    setApiTopicConfig(next.id, {
      ...config,
      ...(opts.defaultModel !== undefined ? { model: undefined, modelLocked: undefined } : {}),
      ...(opts.defaultEffort !== undefined ? { effort: undefined, effortLocked: undefined } : {}),
    });
  }

  WsHub.get().broadcastTopicUpdated(next.id);
  return getTopic(next.id) ?? next;
}
