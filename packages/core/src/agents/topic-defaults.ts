// Resolution of archiver-assigned execution defaults for a memory persona.
//
// The archiver stores only a model (plus optional effort); the agent backend is
// always derived from the model through `modelOwner`, so no caller can pin an
// agent/model pair that the registries disagree about. A stored value that has
// since become invalid — model deprecated, agent removed from this build — is
// ignored in silence and the caller falls back to its own defaults.
import { canonicalModelId, modelOwner } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { DEFAULT_TOPIC_EFFORT } from "#platform/config";
import { logger } from "#platform/logger";
import {
  getTopicDefaultAssignment,
  normalizeMemoryKey,
  upsertTopicDefaultAssignment,
} from "#storage/topic-default-assignments";
import type { AgentKind, EffortLevel } from "#types";

export interface AssignedTopicDefaults {
  memoryKey: string;
  agent: AgentKind;
  model: string;
  effort: EffortLevel;
  reason?: string;
}

/**
 * Validate an archiver-assigned model/effort pair against the live registries.
 * Returns null when the pair cannot be honoured, which callers must treat as
 * "no assignment" rather than as an error.
 */
export function validateAssignedDefaults(
  model: string,
  effort?: string,
): { agent: AgentKind; model: string; effort: EffortLevel } | null {
  const candidate = canonicalModelId(model.trim());
  if (!candidate) return null;
  const agent = modelOwner(candidate);
  if (!agent) return null;
  let registry:
    | { validateModel(value: string): boolean; validateEffort(value: string): boolean }
    | undefined;
  try {
    registry = getRegistry(agent);
  } catch {
    return null;
  }
  if (!registry?.validateModel(candidate)) return null;
  const requestedEffort = effort?.trim().toLowerCase();
  const resolvedEffort =
    requestedEffort && registry.validateEffort(requestedEffort)
      ? (requestedEffort as EffortLevel)
      : registry.validateEffort(DEFAULT_TOPIC_EFFORT)
        ? DEFAULT_TOPIC_EFFORT
        : undefined;
  if (!resolvedEffort) return null;
  return { agent, model: candidate, effort: resolvedEffort };
}

/**
 * Look up the defaults assigned to a memory persona. Storage failures are
 * swallowed: a missing assignment table must never block topic creation.
 */
export function resolveAssignedTopicDefaults(
  memoryKey: string | undefined,
): AssignedTopicDefaults | null {
  const key = memoryKey ? normalizeMemoryKey(memoryKey) : "";
  if (!key) return null;
  let stored: ReturnType<typeof getTopicDefaultAssignment>;
  try {
    stored = getTopicDefaultAssignment(key);
  } catch (err) {
    logger.warn({ err, memoryKey: key }, "topic-defaults: assignment lookup failed");
    return null;
  }
  if (!stored) return null;
  const validated = validateAssignedDefaults(stored.model, stored.effort);
  if (!validated) {
    logger.info(
      { memoryKey: key, model: stored.model, effort: stored.effort },
      "topic-defaults: stored assignment is stale - falling back to node defaults",
    );
    return null;
  }
  return {
    memoryKey: key,
    ...validated,
    ...(stored.reason ? { reason: stored.reason } : {}),
  };
}

export interface AssignTopicDefaultsInput {
  memoryKey: string;
  model: string;
  effort?: string;
  reason?: string;
}

export interface AssignTopicDefaultsResult {
  agent: AgentKind;
  model: string;
  effort: EffortLevel;
  assignCount: number;
}

/**
 * Assignment sink handed to the wiki MCP server. Validating here rather than in
 * the MCP layer keeps one definition of "a model this node can actually run",
 * shared by the write path and the read path.
 */
export function assignTopicDefaults(
  input: AssignTopicDefaultsInput,
): AssignTopicDefaultsResult | null {
  const validated = validateAssignedDefaults(input.model, input.effort);
  if (!validated) return null;
  try {
    const stored = upsertTopicDefaultAssignment({
      memoryKey: input.memoryKey,
      model: validated.model,
      effort: validated.effort,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return stored ? { ...validated, assignCount: stored.assignCount } : null;
  } catch (err) {
    logger.warn({ err, memoryKey: input.memoryKey }, "topic-defaults: assignment write failed");
    return null;
  }
}
