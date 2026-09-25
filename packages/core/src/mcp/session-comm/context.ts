import {
  ACTOR_TOPIC_SCOPE_MAX_AGE_CEILING_MS,
  parseActorTopicScope,
} from "#runtime/actor-topic-scope";
import { decodeRemoteSessionGrantArg } from "#runtime/remote-session-grant";
import type { ActorTopicScope, AgentKind, RemoteSessionGrant } from "#types";
import { isAgentKind } from "#types";

export interface SessionCommContext {
  userId: string;
  /** Product-side human actor when it differs from the execution principal. */
  actorUserId?: string;
  /**
   * Hub-asserted rooms the actor may reach. Only consulted on the `otium`
   * surface, where this node holds no per-person membership. Authoritative
   * when present (exactly the current room plus the asserted rooms, no
   * lineage); absent there (a turn no person started) means the tools reach
   * only the current room plus its own subagent lineage.
   */
  actorTopicScope?: ActorTopicScope;
  /**
   * How long `actorTopicScope` is believed after its `issuedAt`. Set for the
   * stdio child from `--actor-topic-scope-max-age-ms` (it does not inherit the
   * node's env); unset means `actorTopicScopeMaxAgeMs()` of this process.
   */
  actorTopicScopeMaxAgeMs?: number;
  /**
   * Hub-issued per-turn authority for the remote (`node/topic`) branches on
   * the `otium` surface. Opaque to the node; presented to the hub as a bearer.
   * Absent means those branches are fail-closed there.
   */
  remoteSession?: RemoteSessionGrant;
  currentTopic: string;
  currentTopicId?: string;
  /** Thread the calling turn is answering inside, when it is answering in one. */
  currentThreadRootId?: string;
  /** Present for a subagent room; outbound ask_session is not exposed. */
  subagentParentTopicId?: string;
  peerHostQueryId?: string;
  /** Snapshot supplied to standalone MCP child processes by the runtime host. */
  cronSessionId?: string;
  depth: number;
  replyOnly: boolean;
  agent: AgentKind;
}

export interface SessionCommContextDefaults {
  userId: string;
  agent: AgentKind;
}

function value(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** Parse standalone CLI arguments without reading process globals. */
export function parseSessionCommContext(
  args: readonly string[],
  defaults: SessionCommContextDefaults,
): SessionCommContext {
  const agentValue = value(args, "agent");
  if (agentValue !== undefined && !isAgentKind(agentValue)) {
    throw new Error(`Invalid --agent arg: ${agentValue}`);
  }
  const depthValue = value(args, "depth");
  const depth = depthValue === undefined ? 0 : Number(depthValue);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`Invalid --depth arg: ${depthValue}`);
  }
  const scopeValue = value(args, "actor-topic-scope");
  let actorTopicScope: ActorTopicScope | undefined;
  if (scopeValue) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(scopeValue, "base64url").toString("utf-8"));
    } catch {
      throw new Error("Invalid --actor-topic-scope arg");
    }
    const parsed = parseActorTopicScope(decoded);
    if (!parsed) throw new Error("Invalid --actor-topic-scope arg");
    actorTopicScope = parsed;
  }
  const maxAgeValue = value(args, "actor-topic-scope-max-age-ms");
  let actorTopicScopeMaxAgeMs: number | undefined;
  if (maxAgeValue !== undefined) {
    if (!/^\d+$/.test(maxAgeValue)) throw new Error(`Invalid --actor-topic-scope-max-age-ms arg`);
    actorTopicScopeMaxAgeMs = Math.min(Number(maxAgeValue), ACTOR_TOPIC_SCOPE_MAX_AGE_CEILING_MS);
  }
  const grantValue = value(args, "remote-session-grant");
  let remoteSession: RemoteSessionGrant | undefined;
  if (grantValue) {
    const decoded = decodeRemoteSessionGrantArg(grantValue);
    if (!decoded) throw new Error("Invalid --remote-session-grant arg");
    remoteSession = decoded;
  }
  return {
    userId: value(args, "user-id") ?? defaults.userId,
    actorUserId: value(args, "actor-user-id") || undefined,
    ...(actorTopicScope ? { actorTopicScope } : {}),
    ...(actorTopicScopeMaxAgeMs !== undefined ? { actorTopicScopeMaxAgeMs } : {}),
    ...(remoteSession ? { remoteSession } : {}),
    currentTopic: value(args, "topic") ?? "",
    currentTopicId: value(args, "topic-id") || undefined,
    currentThreadRootId: value(args, "thread-root-id") || undefined,
    subagentParentTopicId: value(args, "subagent-parent-topic-id") || undefined,
    peerHostQueryId: value(args, "peer-host-query-id") || undefined,
    cronSessionId: value(args, "cron-session-id") || undefined,
    depth,
    replyOnly: value(args, "reply-only") === "true",
    agent: agentValue ?? defaults.agent,
  };
}
