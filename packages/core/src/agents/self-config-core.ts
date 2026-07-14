import { switchApiTopicAgent } from "#agents/api-topic-agent-switch";
import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import { clearTopicSessionId, getTopic } from "#storage/api-topics";
import { createDerivedTopic, TopicTitleConflictError } from "#topics/derive";
import { topicMarkdownLink } from "#topics/links";
import type { AgentKind, EffortLevel } from "#types";
import type { TopicDto } from "#types/api";

export const SELF_CONFIG_MCP_KEY = "topic-config";

export type SelfConfigField = "agent" | "model" | "effort";

export interface SelfConfigContext {
  topicId: string;
  userId: string;
  cwd?: string;
  /** Raw current user request. Used to prevent autonomous MCP agent switches. */
  currentUserPrompt?: string;
  /** Called after a successful set_* so the caller can trigger a follow-up turn. */
  onConfigChanged?: (field: SelfConfigField) => void;
}

export interface SelfConfigResult {
  text: string;
  isError?: boolean;
}

function ok(text: string): SelfConfigResult {
  return { text };
}

function err(text: string): SelfConfigResult {
  return { text, isError: true };
}

function requireTopic(ctx: SelfConfigContext): TopicDto | SelfConfigResult {
  if (!ctx.topicId || !ctx.userId) return err("Error: missing topicId/userId context.");
  const topic = getTopic(ctx.topicId);
  if (!topic) return err(`Error: topic '${ctx.topicId}' not found.`);
  if (!topic.participants.some((p) => p.userId === ctx.userId)) {
    return err("Error: user is not a member of this topic.");
  }
  if (!topic.agent) return err("Error: this topic has no AI agent invited.");
  return topic;
}

function isResult(value: TopicDto | SelfConfigResult): value is SelfConfigResult {
  return "text" in value;
}

function currentAgent(topic: TopicDto): AgentKind {
  return (topic.agent ?? "maestro") as AgentKind;
}

function effectiveDefaultModel(topic: TopicDto, agent: AgentKind): string {
  const registry = getRegistry(agent);
  return resolveModelForAgent(agent, topic.defaultModel, registry);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentAliases(agent: AgentKind): string[] {
  switch (agent) {
    case "codex":
      return ["codex", "코덱스", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
    case "claude":
      return ["claude", "클로드", "sonnet", "opus", "fable"];
    case "maestro":
      return [
        "maestro",
        "마에스트로",
        "메스트로",
        "deepseek",
        "deepseek-pro",
        "deepseek-flash",
        "딥시크",
      ];
  }
}

function hasExplicitAgentSwitchRequest(prompt: string | undefined, agent: AgentKind): boolean {
  if (!prompt?.trim()) return false;
  const text = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const aliases = agentAliases(agent).map(escapeRegExp);
  const target = `(?:${aliases.join("|")})`;
  const switchVerb =
    "(?:바꿔|바꿔줘|변경|변경해|전환|전환해|설정|설정해|써줘|사용|가|switch|change|set|use)";
  const switchSubject = "(?:agent|runtime|model|에이전트|런타임|모델)";

  return [
    new RegExp(`^/(?:agent|runtime)\\s+${target}(?:\\s|$)`, "iu"),
    new RegExp(`${target}\\s*(?:로|으로)\\s*.{0,16}${switchVerb}`, "iu"),
    new RegExp(`${switchSubject}.{0,24}${target}.{0,24}${switchVerb}`, "iu"),
    new RegExp(`${switchVerb}.{0,24}${switchSubject}.{0,24}${target}`, "iu"),
    new RegExp(`(?:switch|change|set|use).{0,24}${target}`, "iu"),
  ].some((pattern) => pattern.test(text));
}

export function setSelfConfigModel(ctx: SelfConfigContext, model: string): SelfConfigResult {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  const cfg = getApiTopicConfig(topic.id) ?? {};
  if (cfg.modelLocked) return err("Model for this topic is locked by the user. Cannot override.");

  const agent = currentAgent(topic);
  const registry = getRegistry(agent);
  if (!registry.validateModel(model)) {
    return err(
      `'${model}' is not a valid model for agent '${agent}'. If it belongs to another agent, call set_agent first.`,
    );
  }

  setApiTopicConfig(topic.id, { ...cfg, model });
  // Provider sessions, notably Codex threads, are bound to their creation
  // model and cannot safely be resumed after a model change.
  clearTopicSessionId(topic.id, "self-config-model-changed");
  ctx.onConfigChanged?.("model");
  return ok(`Model for this topic set to '${model}' (agent=${agent}). Applies from the next turn.`);
}

export function getSelfConfigModel(ctx: SelfConfigContext): SelfConfigResult {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  const cfg = getApiTopicConfig(topic.id);
  const agent = currentAgent(topic);
  const value = cfg?.model ?? `default (${effectiveDefaultModel(topic, agent)})`;
  const lock = cfg?.modelLocked ? " [locked by user]" : "";
  return ok(`Model (agent=${agent}): ${value}${lock}`);
}

export function setSelfConfigAgent(ctx: SelfConfigContext, agent: AgentKind): SelfConfigResult {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  const cfg = getApiTopicConfig(topic.id) ?? {};
  // Agent is a topic property; the same path is used by UI and MCP.

  const existing = currentAgent(topic);
  if (existing === agent) return ok(`Agent is already '${agent}'. No change.`);
  if (cfg.agentLocked) return err("Agent for this topic is locked by the user. Cannot override.");
  if (!hasExplicitAgentSwitchRequest(ctx.currentUserPrompt, agent)) {
    return err(
      "Agent switch requires an explicit current user request such as '/model gpt-5.6-luna' or 'codex로 바꿔'.",
    );
  }

  // Switching agents invalidates provider-native session ids and per-agent
  // model/effort overrides. The helper mirrors Otium's switchTopicAgent:
  // write rollout, manifest the synthetic session in the unified log, then
  // commit config + durable session.
  const switched = switchApiTopicAgent({
    topicId: topic.id,
    topicTitle: topic.title,
    userId: ctx.userId,
    fromAgent: existing,
    agent,
    cwd: ctx.cwd ?? resolveTopicWorkspaceDir(topic.id),
    config: { ...cfg, model: undefined, effort: undefined },
    defaultModel: topic.defaultModel,
    defaultEffort: topic.defaultEffort,
    reason: "self-config-agent-switch",
  });
  if (!switched.ok) return err(switched.error);

  ctx.onConfigChanged?.("agent");
  const sessionNote =
    switched.outcome.kind === "bridged"
      ? ` Conversation history was bridged into a ${agent} session (${switched.outcome.bridgedSessionId}).`
      : switched.outcome.reason === "bridge-failed"
        ? " Conversation history bridge failed; the next turn starts fresh."
        : " No prior conversation history was found; the next turn starts fresh.";
  return ok(
    `Agent for this topic set to '${agent}'. Model/effort reset to '${agent}' defaults.${sessionNote}`,
  );
}

export function getSelfConfigAgent(ctx: SelfConfigContext): SelfConfigResult {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  const lock = "";
  return ok(`Agent: ${currentAgent(topic)}${lock}`);
}

export function setSelfConfigEffort(ctx: SelfConfigContext, effort: EffortLevel): SelfConfigResult {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  const cfg = getApiTopicConfig(topic.id) ?? {};
  if (cfg.effortLocked) return err("Effort for this topic is locked by the user. Cannot override.");

  const agent = currentAgent(topic);
  const registry = getRegistry(agent);
  if (!registry.validateEffort(effort)) {
    return err(
      `'${effort}' is not a valid effort for agent '${agent}'. Valid: ${registry.validEfforts.join(", ")}.`,
    );
  }

  setApiTopicConfig(topic.id, { ...cfg, effort });
  ctx.onConfigChanged?.("effort");
  return ok(
    `Effort for this topic set to '${effort}' (agent=${agent}). Applies from the next turn.`,
  );
}

export function getSelfConfigEffort(ctx: SelfConfigContext): SelfConfigResult {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  const cfg = getApiTopicConfig(topic.id);
  const agent = currentAgent(topic);
  const registry = getRegistry(agent);
  const fallback = registry.defaultEffort ? `default (${registry.defaultEffort})` : "default (off)";
  const value = cfg?.effort ?? fallback;
  const lock = cfg?.effortLocked ? " [locked by user]" : "";
  return ok(`Effort (agent=${agent}): ${value}${lock}`);
}

export async function spawnSelfConfigTopic(
  ctx: SelfConfigContext,
  name?: string,
): Promise<SelfConfigResult> {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  let derived: TopicDto | null;
  try {
    derived = await createDerivedTopic(topic.id, ctx.userId, false, { name });
  } catch (e) {
    if (e instanceof TopicTitleConflictError) return err(`${e.message} — pick a different name.`);
    throw e;
  }
  if (!derived) return err("Failed to spawn topic (source not found or permission denied).");
  return ok(`Spawned new topic "${derived.title}".\nLink: ${topicMarkdownLink(derived.id)}`);
}

export async function forkSelfConfigTopic(
  ctx: SelfConfigContext,
  name?: string,
): Promise<SelfConfigResult> {
  const topic = requireTopic(ctx);
  if (isResult(topic)) return topic;

  let derived: TopicDto | null;
  try {
    derived = await createDerivedTopic(topic.id, ctx.userId, true, { name });
  } catch (e) {
    if (e instanceof TopicTitleConflictError) return err(`${e.message} — pick a different name.`);
    throw e;
  }
  if (!derived) return err("Failed to fork topic (source not found or permission denied).");
  return ok(
    `Forked new topic "${derived.title}". History copied.\nLink: ${topicMarkdownLink(derived.id)}`,
  );
}
