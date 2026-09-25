import {
  getTopic,
  listSubagentChildTopicIds,
  listSubagentTellTargetIds,
} from "#storage/api-topics";
import type { ActorTopicScope } from "#types";

/**
 * Rooms a turn may reach because of lineage this node itself recorded, not
 * because a person is in them: a subagent's direct parent and the targets an
 * ancestor granted it, and a room's own subagent workers.
 *
 * Lineage stands in for an assertion only when there is none — the turns that
 * manage subagents (the spawn, the report back, the follow-up) are turns no
 * person started, they carry no `actorTopicScope`, and cutting them off would
 * break delegation the moment it began. A turn that *does* carry an assertion
 * never gets lineage on top of it: the hub mirrors a subagent room with its
 * parent's roster, so an owner of the parent is asserted as owner of the child
 * and needs no exception, while a member who is not the owner — or a person
 * speaking from a subagent room an ancestor granted rooms outside that
 * person's own — must not inherit authority the hub did not assert.
 * `canSubagentTellTarget` still applies its own rules on top (status-only,
 * grants).
 */
export function subagentLineageTopicIds(currentTopicId: string | undefined): {
  reachable: Set<string>;
  children: Set<string>;
} {
  const reachable = new Set<string>();
  const children = new Set<string>();
  if (!currentTopicId) return { reachable, children };
  const current = getTopic(currentTopicId);
  if (current?.isSubagent && current.parentTopicId) {
    reachable.add(current.parentTopicId);
    for (const id of listSubagentTellTargetIds(currentTopicId)) reachable.add(id);
  }
  for (const id of listSubagentChildTopicIds(currentTopicId)) {
    reachable.add(id);
    children.add(id);
  }
  return { reachable, children };
}

/**
 * The rooms cross-room tools may name for this turn.
 *
 * Off the `otium` surface the node owns membership, so nothing narrows the
 * caller's own rooms. On `otium` the hub does, and its assertion is
 * authoritative: with one, exactly the current room plus the asserted visible
 * rooms are reachable — no lineage. Without one (an older hub, or a turn no
 * person started) only the current room and its subagent lineage are
 * reachable (fail-closed).
 */
export function actorReachableTopicIds(input: {
  surface: string | undefined;
  currentTopicId: string | undefined;
  actorTopicScope: ActorTopicScope | undefined;
}): ReadonlySet<string> | null {
  if (input.surface !== "otium") return null;
  const ids = new Set<string>();
  if (input.currentTopicId) ids.add(input.currentTopicId);
  if (input.actorTopicScope) {
    for (const id of input.actorTopicScope.visibleNodeTopicIds) ids.add(id);
    return ids;
  }
  for (const id of subagentLineageTopicIds(input.currentTopicId).reachable) ids.add(id);
  return ids;
}

/**
 * Rooms the actor may abort/restart/delete. With an assertion: exactly the
 * rooms the hub says the actor owns (a parent's subagent workers are among
 * them only if the hub asserted so). Without one: the current room's own
 * subagent workers (a room controls what it delegated), nothing else. Same
 * surface rule as {@link actorReachableTopicIds}.
 */
export function actorOwnedTopicIds(input: {
  surface: string | undefined;
  currentTopicId?: string | undefined;
  actorTopicScope: ActorTopicScope | undefined;
}): ReadonlySet<string> | null {
  if (input.surface !== "otium") return null;
  if (input.actorTopicScope) return new Set(input.actorTopicScope.ownedNodeTopicIds);
  return subagentLineageTopicIds(input.currentTopicId).children;
}
