import type { AgentKind } from "#types";
import { isAgentKind } from "#types";

export interface SessionCommContext {
  userId: string;
  currentTopic: string;
  currentTopicId?: string;
  peerHostQueryId?: string;
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
  return {
    userId: value(args, "user-id") ?? defaults.userId,
    currentTopic: value(args, "topic") ?? "",
    currentTopicId: value(args, "topic-id") || undefined,
    peerHostQueryId: value(args, "peer-host-query-id") || undefined,
    depth,
    replyOnly: value(args, "reply-only") === "true",
    agent: agentValue ?? defaults.agent,
  };
}
