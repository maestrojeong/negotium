import { subagentReportMode } from "#agents/mcp-tools/spawn-subagent";
import { getTopic, getTopicByName, listSubagentTellTargetIds } from "#storage/api-topics";

/**
 * Restriction identity for outbound subagent session communication.
 *
 * This is the single source of truth for the subagent tell rules; every
 * session-comm surface (standalone server and shared factory) must consume it
 * so the security boundary does not depend on which host is wired.
 */
export interface SubagentTellIdentity {
  /** Topic id of the room attempting the tell (undefined when unknown). */
  currentTopicId: string | undefined;
  /** Resolved parent topic id; undefined when identity is invalid or not a subagent. */
  parentTopicId: string | undefined;
  /** Whether subagent tell restrictions apply to this room. */
  restricted: boolean;
}

/** Derive the restriction identity from the asserted parent arg plus the topic record. */
export function resolveSubagentTellIdentity(
  currentTopicId: string | undefined,
  assertedParentTopicId: string | undefined,
): SubagentTellIdentity {
  const record = currentTopicId ? getTopic(currentTopicId) : undefined;
  // A missing topic record only invalidates identity when subagent identity is
  // actually asserted; otherwise a transient read miss would silently downgrade
  // a plain top-level agent to zero outbound capability.
  const identityInvalid =
    Boolean(
      assertedParentTopicId &&
        (!record?.isSubagent || record.parentTopicId !== assertedParentTopicId),
    ) || Boolean(record?.isSubagent && !record.parentTopicId);
  const restricted =
    identityInvalid || Boolean(assertedParentTopicId) || Boolean(record?.isSubagent);
  const parentTopicId = identityInvalid
    ? undefined
    : assertedParentTopicId || (record?.isSubagent ? record.parentTopicId : undefined);
  return { currentTopicId, parentTopicId, restricted };
}

/**
 * Whether the room may tell_session the target topic: unrestricted rooms may
 * always tell; subagents may tell their direct parent (unless status-only),
 * their direct children, or targets explicitly granted by an ancestor.
 */
export function canSubagentTellTarget(
  identity: SubagentTellIdentity,
  targetTopicId: string,
): boolean {
  if (!identity.restricted) return true;
  if (!identity.parentTopicId || !identity.currentTopicId) return false;
  if (
    targetTopicId === identity.parentTopicId &&
    subagentReportMode(identity.currentTopicId) === "status-only"
  ) {
    return false;
  }
  return (
    targetTopicId === identity.parentTopicId ||
    getTopic(targetTopicId)?.parentTopicId === identity.currentTopicId ||
    listSubagentTellTargetIds(identity.currentTopicId).includes(targetTopicId)
  );
}

/**
 * Fail-closed tell check for surfaces that only know the target by name/id.
 * Unrestricted rooms pass without resolution; restricted rooms must resolve
 * the target to a local topic that passes `canSubagentTellTarget`.
 */
export function canSubagentTellTargetByName(
  identity: SubagentTellIdentity,
  target: string,
): boolean {
  if (!identity.restricted) return true;
  const resolved = getTopic(target) ?? getTopicByName(target);
  if (!resolved) return false;
  return canSubagentTellTarget(identity, resolved.id);
}
