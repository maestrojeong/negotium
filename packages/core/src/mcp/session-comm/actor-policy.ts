/**
 * Actor-facing rules shared by the two session-comm implementations — the
 * hosted `default-host.ts` and the stdio `server.ts`. They used to apply the
 * owner check and the peer rules independently and drifted (the stdio server
 * lost the owner check on `abort_session`); one module keeps them identical.
 */
import { type ActorTopicScopeClock, actorOwnedTopicIds } from "#runtime/actor-topic-reach";
import type { ActorTopicScope, RemoteSessionGrant } from "#types";

export interface ActorTopicPolicyInput {
  surface: string | undefined;
  currentTopicId: string | undefined;
  actorTopicScope: ActorTopicScope | undefined;
  /** Freshness clock/window for the assertion (defaults: now, env window). */
  clock?: ActorTopicScopeClock;
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
  const owned = actorOwnedTopicIds(input, input.clock);
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

/**
 * Whether the node's own roster (`participants` / `topic_members`) bounds
 * which local rooms session-comm may list and address on this surface.
 *
 * Off `otium` this node owns membership and the roster is the boundary.
 * On `otium` it is not (design Q1): a node topic's participants there are
 * only its execution principal — the hub's `local`, or the person who owned
 * a synced node topic, and some rooms carry both — so matching them against
 * the turn's principal hid rooms the person may reach and proved nothing
 * about the ones it showed. There the boundary is the workspace (surface +
 * scope, applied in the store query) intersected with
 * `actorReachableTopicIds`: the hub's signed per-turn assertion when present,
 * else only the current room and its own subagent lineage (fail-closed).
 */
export function rosterBoundsSessionTargets(surface: string | undefined): boolean {
  return surface !== "otium";
}

export interface DeliveryParticipant {
  userId: string;
  role?: string;
}

/**
 * The principal a local tell/ask/abort inbox entry is filed under — which is
 * also the principal the target's turn runs as (`runtime/inbox.ts` hands the
 * entry's principal to `triggerTopicAiTurn`, and the turn's vault namespace,
 * browser profile and tool grants follow from it).
 *
 * Always the calling turn's own principal, and only when that principal is a
 * participant of the target room; otherwise `null` and the call is refused.
 * Seeing a room (design Q1: on `otium` the roster no longer bounds the
 * listing) is not the right to make it run: filing the entry under the
 * room's owner instead would run one principal's prompt with another
 * principal's credentials (a confused deputy), which Q1 does not approve.
 */
export function localDeliveryPrincipal(input: {
  callerUserId: string;
  targetParticipants: readonly DeliveryParticipant[] | undefined;
}): string | null {
  const participants = input.targetParticipants ?? [];
  return participants.some((p) => p.userId === input.callerUserId) ? input.callerUserId : null;
}

/**
 * The principal a room's turns run under, for read-only status (peek): the
 * caller's when it is a participant, else the room's owner. Never used to
 * file an inbox entry — see {@link localDeliveryPrincipal}.
 */
export function roomStatusPrincipal(input: {
  callerUserId: string;
  targetParticipants: readonly DeliveryParticipant[] | undefined;
}): string | null {
  const participants = input.targetParticipants ?? [];
  if (participants.some((p) => p.userId === input.callerUserId)) return input.callerUserId;
  return (participants.find((p) => p.role === "owner") ?? participants[0])?.userId ?? null;
}

/**
 * Refusal for a local `tell_session`/`ask_session`/`abort_session` whose
 * target room runs under a different execution principal than the calling
 * turn (see {@link localDeliveryPrincipal}). Explicit, never a silent drop,
 * and returned before any inbox entry or pending-ask record exists.
 */
export function crossPrincipalRefusal(
  tool: "tell_session" | "ask_session" | "abort_session",
  to: string,
): string {
  return `Error: ${tool} to "${to}" is not available: that room runs under a different execution principal on this node, and a session cannot act as another principal.`;
}
