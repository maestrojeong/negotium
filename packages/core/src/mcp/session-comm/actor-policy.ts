/**
 * Actor-facing rules shared by the two session-comm implementations — the
 * hosted `default-host.ts` and the stdio `server.ts`. They used to apply the
 * owner check and the peer rules independently and drifted (the stdio server
 * lost the owner check on `abort_session`); one module keeps them identical.
 */
import { actorOwnedTopicIds } from "#runtime/actor-topic-reach";
import type { ActorTopicScope, RemoteSessionGrant } from "#types";

export interface ActorTopicPolicyInput {
  surface: string | undefined;
  currentTopicId: string | undefined;
  actorTopicScope: ActorTopicScope | undefined;
}

/**
 * Whether the calling turn may stop work in `targetTopicId`, and the refusal
 * to return when it may not. Stopping someone else's work is an owner's call:
 * on `otium` that is the hub's owner assertion when the turn carries one, and
 * only the current room's own subagent workers when it does not (a turn no
 * person started). A room the actor can see but does not own answers as if
 * it were not there, so the refusal reveals nothing the listing did not.
 * Off `otium` the node's membership already decided; returns `null`.
 */
export function abortTargetRefusal(
  input: ActorTopicPolicyInput & { targetTopicId: string; to: string },
): string | null {
  const owned = actorOwnedTopicIds(input);
  if (owned && !owned.has(input.targetTopicId)) return `Error: Session "${input.to}" not found.`;
  return null;
}

/**
 * Whether remote (`node/topic`) session-comm is available to this turn, and
 * the refusal to return when it is not.
 *
 * A peer call carries the node's execution principal and, at most, the hub
 * query id of a worker turn — never who spoke or which rooms they may reach.
 * Off `otium` that is fine: the principal *is* the person. On `otium` the
 * principal is the hub itself and sits in every room, so a peer call would be
 * authorized as the hub, for anyone. There the only remote path is the hub
 * itself: a turn the hub started for a person carries a per-turn
 * {@link RemoteSessionGrant} and the remote branches go to the hub, which
 * re-checks that person's membership on every call. Without a grant — an
 * older hub, the feature off, or a turn no person started — the remote
 * branches stay fail-closed: remote listings contribute nothing and remote
 * tell/ask/abort refuse.
 */
export function remotePeerRefusal(
  surface: string | undefined,
  remoteSession?: RemoteSessionGrant,
): string | null {
  if (surface !== "otium") return null;
  if (remoteSession) return null;
  return "Error: remote sessions (node/topic) cannot be reached from an Otium room: this turn carries no hub remote-session grant, so the call cannot be authorized for the person who spoke.";
}

/**
 * Which transport the remote (`node/topic`) branch of a session-comm tool
 * uses for this turn — the hub with the turn's grant, the legacy peer bridge
 * off `otium`, or nothing (with the refusal to return).
 */
export type RemoteSessionRoute =
  | { kind: "hub"; grant: RemoteSessionGrant }
  | { kind: "peer" }
  | { kind: "refused"; error: string };

export function remoteSessionRoute(
  surface: string | undefined,
  remoteSession: RemoteSessionGrant | undefined,
): RemoteSessionRoute {
  if (surface === "otium" && remoteSession) return { kind: "hub", grant: remoteSession };
  const refused = remotePeerRefusal(surface, remoteSession);
  if (refused) return { kind: "refused", error: refused };
  return { kind: "peer" };
}

/**
 * Whether the session-comm catalog on this surface drops rooms that have no
 * AI. On `otium` a human-only channel is never a target — it cannot be told,
 * asked or aborted — so it is excluded at the catalog level rather than
 * listed idle and refused later. Other surfaces keep listing them so the
 * "has no AI agent" explanation stays reachable.
 */
export function excludesAgentlessTargets(surface: string | undefined): boolean {
  return surface === "otium";
}
