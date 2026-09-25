import { isActorTopicScopeFresh } from "#runtime/actor-topic-scope";
import {
  getTopic,
  listSubagentChildTopicIds,
  listSubagentTellTargetIds,
} from "#storage/api-topics";
import type { ActorTopicScope } from "#types";

/** Clock and window for the assertion freshness check (tests pass their own). */
export interface ActorTopicScopeClock {
  now?: number;
  maxAgeMs?: number;
}

function fresh(scope: ActorTopicScope, clock: ActorTopicScopeClock): boolean {
  return isActorTopicScopeFresh(scope, clock.now, clock.maxAgeMs);
}

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
 * authoritative: with a fresh one, exactly the current room plus the asserted
 * visible rooms are reachable — no lineage. Without one (an older hub, or a
 * turn no person started) only the current room and its subagent lineage are
 * reachable (fail-closed).
 *
 * A stale assertion (older than `actorTopicScopeMaxAgeMs()`, or unstamped)
 * proves nothing about the person's rooms *now*, so it grants no cross-room
 * reach: the current room plus the part of its own lineage the assertion also
 * named. That is never more than either a fresh assertion or bare lineage
 * would give, so an assertion going stale can only narrow a turn. Evaluated
 * on every call, so a long-running turn loses cross-room reach mid-turn.
 */
export function actorReachableTopicIds(
  input: {
    surface: string | undefined;
    currentTopicId: string | undefined;
    actorTopicScope: ActorTopicScope | undefined;
  },
  clock: ActorTopicScopeClock = {},
): ReadonlySet<string> | null {
  if (input.surface !== "otium") return null;
  const ids = new Set<string>();
  if (input.currentTopicId) ids.add(input.currentTopicId);
  const scope = input.actorTopicScope;
  if (scope) {
    if (fresh(scope, clock)) {
      for (const id of scope.visibleNodeTopicIds) ids.add(id);
      return ids;
    }
    const asserted = new Set(scope.visibleNodeTopicIds);
    for (const id of subagentLineageTopicIds(input.currentTopicId).reachable) {
      if (asserted.has(id)) ids.add(id);
    }
    return ids;
  }
  for (const id of subagentLineageTopicIds(input.currentTopicId).reachable) ids.add(id);
  return ids;
}

/**
 * Rooms the actor may abort/restart/delete. With a fresh assertion: exactly
 * the rooms the hub says the actor owns (a parent's subagent workers are
 * among them only if the hub asserted so). With a stale one: only the current
 * room's own subagent workers the assertion also said the actor owns. Without
 * one: the current room's own subagent workers (a room controls what it
 * delegated), nothing else. Same surface and freshness rules as
 * {@link actorReachableTopicIds}.
 */
export function actorOwnedTopicIds(
  input: {
    surface: string | undefined;
    currentTopicId?: string | undefined;
    actorTopicScope: ActorTopicScope | undefined;
  },
  clock: ActorTopicScopeClock = {},
): ReadonlySet<string> | null {
  if (input.surface !== "otium") return null;
  const scope = input.actorTopicScope;
  if (scope && fresh(scope, clock)) return new Set(scope.ownedNodeTopicIds);
  const children = subagentLineageTopicIds(input.currentTopicId).children;
  if (!scope) return children;
  const asserted = new Set(scope.ownedNodeTopicIds);
  return new Set([...children].filter((id) => asserted.has(id)));
}
