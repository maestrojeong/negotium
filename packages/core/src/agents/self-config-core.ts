import { switchApiTopicAgent } from "#agents/api-topic-agent-switch";
import { checkAgentModelAuth } from "#agents/auth-check";
import { modelOwner, resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { WsHub } from "#bus";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import { getTopic } from "#storage/api-topics";
import {
  cancelPendingSelfSchedule,
  createPendingSelfSchedule,
  getPendingSelfSchedule,
  updatePendingSelfSchedule,
} from "#storage/self-schedules";
import { topicMarkdownLink } from "#topics/links";
import type { AgentKind, EffortLevel } from "#types";

export const SELF_CONFIG_MCP_KEY = "topic-config";
export const SELF_SCHEDULE_MAX_DELAY_SECONDS = 86_400;
export const SELF_SCHEDULE_MAX_MESSAGE_LENGTH = 10_000;
export const SELF_CONFIG_DERIVED_TOPIC_LIMIT = 5;

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

export interface SelfConfigTopic {
  id: string;
  title: string;
  agent?: AgentKind;
  defaultModel: string;
  defaultEffort: EffortLevel;
  participants: readonly { userId: string }[];
}

export interface SelfConfigTopicConfig {
  model?: string;
  effort?: EffortLevel;
  mcp?: string[];
  agentLocked?: boolean;
  modelLocked?: boolean;
  effortLocked?: boolean;
}

export interface SelfConfigAgentPolicy {
  defaultEffort?: EffortLevel;
  validEfforts: readonly EffortLevel[];
  validateModel(model: string): boolean;
  validateEffort(effort: EffortLevel): boolean;
  resolveModel(model: string | undefined): string;
}

export interface SelfConfigTopicStore {
  getTopic(topicId: string): SelfConfigTopic | null;
  getConfig(topicId: string): SelfConfigTopicConfig | undefined;
  setConfig(topicId: string, config: SelfConfigTopicConfig): void;
}

export interface SelfConfigModelPolicy {
  forAgent(agent: AgentKind): SelfConfigAgentPolicy;
  owner(model: string): AgentKind | undefined;
  checkAuth(
    agent: AgentKind,
    model: string,
    userId: string,
  ): { ok: true } | { ok: false; error: string };
}

export interface SelfConfigRuntimeBoundary {
  resolveWorkspaceDir(topicId: string): string;
  switchAgent(options: SelfConfigAgentSwitchOptions): SelfConfigAgentSwitchResult;
  configChanged(topicId: string, field: SelfConfigField): void;
}

export type SelfConfigAgentSwitchResult =
  | {
      ok: true;
      outcome:
        | { kind: "fresh"; agent: AgentKind; reason: "no-history" }
        | {
            kind: "bridged";
            agent: AgentKind;
            bridgedSessionId: string;
            rolloutPath: string;
          };
    }
  | { ok: false; error: string };

export interface SelfConfigAgentSwitchOptions {
  topicId: string;
  topicTitle: string;
  userId: string;
  fromAgent?: AgentKind;
  agent: AgentKind;
  cwd: string;
  config: SelfConfigTopicConfig;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  reason: string;
}

export interface SelfConfigDerivedTopics {
  create(
    sourceTopicId: string,
    userId: string,
    copyHistory: boolean,
    options: { name?: string },
  ): Promise<SelfConfigTopic | null>;
  link(topicId: string): string;
  isTitleConflict(error: unknown): boolean;
  isForkCompactionError(error: unknown): boolean;
}

export interface SelfConfigSchedules {
  create(input: {
    topicId: string;
    userId: string;
    message: string;
    deliverAt: number;
    now?: number;
  }): SelfConfigCreateScheduleResult;
  getPending(topicId: string): SelfConfigSchedule | null;
  update(input: {
    topicId: string;
    scheduleId: string;
    message?: string;
    deliverAt?: number;
    now?: number;
  }): SelfConfigSchedule | null;
  cancel(topicId: string, scheduleId: string): boolean;
}

export interface SelfConfigSchedule {
  id: string;
  topicId: string;
  userId: string;
  message: string;
  deliverAt: number;
}

export type SelfConfigCreateScheduleResult =
  | { ok: true; schedule: SelfConfigSchedule }
  | { ok: false; existing: SelfConfigSchedule };

/** Product-level limits and copy that are shared by policy and MCP wrappers. */
export interface SelfConfigProductConfig {
  readonly mcpKey: string;
  readonly scheduleMaxDelaySeconds: number;
  readonly scheduleMaxMessageLength: number;
  readonly derivedTopicLimit: number;
  readonly toolDescriptions: Readonly<Record<string, string>>;
}

export interface SelfConfigHost {
  topics: SelfConfigTopicStore;
  models: SelfConfigModelPolicy;
  runtime: SelfConfigRuntimeBoundary;
  derivedTopics?: SelfConfigDerivedTopics;
  schedules?: SelfConfigSchedules;
}

export interface SelfConfigCore {
  readonly host: SelfConfigHost;
  readonly product: SelfConfigProductConfig;
  setModel(ctx: SelfConfigContext, model: string): SelfConfigResult;
  getModel(ctx: SelfConfigContext): SelfConfigResult;
  setAgent(ctx: SelfConfigContext, agent: AgentKind): SelfConfigResult;
  getAgent(ctx: SelfConfigContext): SelfConfigResult;
  setEffort(ctx: SelfConfigContext, effort: EffortLevel): SelfConfigResult;
  getEffort(ctx: SelfConfigContext): SelfConfigResult;
  scheduleContinue(
    ctx: SelfConfigContext,
    delaySeconds: number,
    message: string,
    nowMs?: number,
  ): SelfConfigResult;
  getSchedule(ctx: SelfConfigContext, nowMs?: number): SelfConfigResult;
  updateSchedule(
    ctx: SelfConfigContext,
    scheduleId: string,
    updates: { delaySeconds?: number; message?: string },
    nowMs?: number,
  ): SelfConfigResult;
  cancelSchedule(ctx: SelfConfigContext, scheduleId: string): SelfConfigResult;
  spawnTopic(ctx: SelfConfigContext, name?: string): Promise<SelfConfigResult>;
  forkTopic(ctx: SelfConfigContext, name?: string): Promise<SelfConfigResult>;
}

export const DEFAULT_SELF_CONFIG_PRODUCT: SelfConfigProductConfig = {
  mcpKey: SELF_CONFIG_MCP_KEY,
  scheduleMaxDelaySeconds: SELF_SCHEDULE_MAX_DELAY_SECONDS,
  scheduleMaxMessageLength: SELF_SCHEDULE_MAX_MESSAGE_LENGTH,
  derivedTopicLimit: SELF_CONFIG_DERIVED_TOPIC_LIMIT,
  toolDescriptions: {},
};

function ok(text: string): SelfConfigResult {
  return { text };
}

function err(text: string): SelfConfigResult {
  return { text, isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentAliases(agent: AgentKind): string[] {
  switch (agent) {
    case "codex":
      return ["codex", "코덱스", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"];
    case "claude":
      return ["claude", "클로드", "sonnet", "opus", "fable"];
    case "maestro":
      return [
        "maestro",
        "마에스트로",
        "메스트로",
        "deepseek",
        "deepseek-pro",
        "kimi",
        "kimi-pro",
        "kimi-k3",
        "kimi-code",
        "kimi-k2.7-code",
        "딥시크",
        "키미",
      ];
  }
}

function hasExplicitAgentSwitchRequest(prompt: string | undefined, agent: AgentKind): boolean {
  if (!prompt?.trim()) return false;
  const text = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const target = `(?:${agentAliases(agent).map(escapeRegExp).join("|")})`;
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

export function createSelfConfigCore(
  host: SelfConfigHost,
  productOverrides: Partial<SelfConfigProductConfig> = {},
): SelfConfigCore {
  const product: SelfConfigProductConfig = Object.freeze({
    ...DEFAULT_SELF_CONFIG_PRODUCT,
    ...productOverrides,
    toolDescriptions: Object.freeze({
      ...DEFAULT_SELF_CONFIG_PRODUCT.toolDescriptions,
      ...productOverrides.toolDescriptions,
    }),
  });
  for (const [name, value] of [
    ["scheduleMaxDelaySeconds", product.scheduleMaxDelaySeconds],
    ["scheduleMaxMessageLength", product.scheduleMaxMessageLength],
    ["derivedTopicLimit", product.derivedTopicLimit],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`self-config product ${name} must be a positive integer`);
    }
  }

  function requireAccessibleTopic(ctx: SelfConfigContext): SelfConfigTopic | SelfConfigResult {
    if (!ctx.topicId || !ctx.userId) return err("Error: missing topicId/userId context.");
    const topic = host.topics.getTopic(ctx.topicId);
    if (!topic) return err(`Error: topic '${ctx.topicId}' not found.`);
    if (!topic.participants.some((participant) => participant.userId === ctx.userId)) {
      return err("Error: user is not a member of this topic.");
    }
    return topic;
  }

  function requireTopic(ctx: SelfConfigContext): SelfConfigTopic | SelfConfigResult {
    const topic = requireAccessibleTopic(ctx);
    if ("text" in topic) return topic;
    if (!topic.agent) return err("Error: this topic has no AI agent invited.");
    return topic;
  }

  function currentAgent(topic: SelfConfigTopic): AgentKind {
    return topic.agent ?? "maestro";
  }

  function setModel(ctx: SelfConfigContext, model: string): SelfConfigResult {
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;

    const config = host.topics.getConfig(topic.id) ?? {};
    if (config.modelLocked) {
      return err("Model for this topic is locked by the user. Cannot override.");
    }

    const agent = currentAgent(topic);
    const policy = host.models.forAgent(agent);
    const owner = host.models.owner(model);
    if ((owner && owner !== agent) || !policy.validateModel(model)) {
      return err(
        `'${model}' is not a valid model for agent '${agent}'. If it belongs to another agent, call set_agent first.`,
      );
    }
    const resolvedModel = policy.resolveModel(model);
    const auth = host.models.checkAuth(agent, resolvedModel, ctx.userId);
    if (!auth.ok) return err(auth.error);

    host.topics.setConfig(topic.id, { ...config, model: resolvedModel });
    host.runtime.configChanged(topic.id, "model");
    ctx.onConfigChanged?.("model");
    return ok(
      `Model for this topic set to '${resolvedModel}' (agent=${agent}). Applies from the next turn.`,
    );
  }

  function getModel(ctx: SelfConfigContext): SelfConfigResult {
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;

    const config = host.topics.getConfig(topic.id);
    const agent = currentAgent(topic);
    const policy = host.models.forAgent(agent);
    const fallback = policy.resolveModel(topic.defaultModel);
    const resolved = config?.model ? policy.resolveModel(config.model) : fallback;
    const value =
      config?.model && resolved === config.model ? config.model : `default (${fallback})`;
    const lock = config?.modelLocked ? " [locked by user]" : "";
    return ok(`Model (agent=${agent}): ${value}${lock}`);
  }

  function setAgent(ctx: SelfConfigContext, agent: AgentKind): SelfConfigResult {
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;

    const config = host.topics.getConfig(topic.id) ?? {};
    const existing = currentAgent(topic);
    if (existing === agent) return ok(`Agent is already '${agent}'. No change.`);
    if (config.agentLocked) {
      return err("Agent for this topic is locked by the user. Cannot override.");
    }
    if (!hasExplicitAgentSwitchRequest(ctx.currentUserPrompt, agent)) {
      return err(
        `Agent switch to '${agent}' requires an explicit request in the current user message.`,
      );
    }

    const switched = host.runtime.switchAgent({
      topicId: topic.id,
      topicTitle: topic.title,
      userId: ctx.userId,
      fromAgent: existing,
      agent,
      cwd: ctx.cwd ?? host.runtime.resolveWorkspaceDir(topic.id),
      config: { ...config, model: undefined, effort: undefined },
      defaultModel: topic.defaultModel,
      defaultEffort: topic.defaultEffort,
      reason: "self-config-agent-switch",
    });
    if (!switched.ok) return err(switched.error);

    host.runtime.configChanged(topic.id, "agent");
    ctx.onConfigChanged?.("agent");
    const sessionNote =
      switched.outcome.kind === "bridged"
        ? ` Conversation history was bridged into a ${agent} session (${switched.outcome.bridgedSessionId}).`
        : " No prior conversation history was found; the next turn starts fresh.";
    return ok(
      `Agent for this topic set to '${agent}'. Model/effort reset to '${agent}' defaults.${sessionNote}`,
    );
  }

  function getAgent(ctx: SelfConfigContext): SelfConfigResult {
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;
    return ok(`Agent: ${currentAgent(topic)}`);
  }

  function setEffort(ctx: SelfConfigContext, effort: EffortLevel): SelfConfigResult {
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;

    const config = host.topics.getConfig(topic.id) ?? {};
    if (config.effortLocked) {
      return err("Effort for this topic is locked by the user. Cannot override.");
    }
    const agent = currentAgent(topic);
    const policy = host.models.forAgent(agent);
    if (!policy.validateEffort(effort)) {
      return err(
        `'${effort}' is not a valid effort for agent '${agent}'. Valid: ${policy.validEfforts.join(", ")}.`,
      );
    }

    host.topics.setConfig(topic.id, { ...config, effort });
    host.runtime.configChanged(topic.id, "effort");
    ctx.onConfigChanged?.("effort");
    return ok(
      `Effort for this topic set to '${effort}' (agent=${agent}). Applies from the next turn.`,
    );
  }

  function getEffort(ctx: SelfConfigContext): SelfConfigResult {
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;

    const config = host.topics.getConfig(topic.id);
    const agent = currentAgent(topic);
    const policy = host.models.forAgent(agent);
    const fallback = policy.defaultEffort ? `default (${policy.defaultEffort})` : "default (off)";
    const value = config?.effort ?? fallback;
    const lock = config?.effortLocked ? " [locked by user]" : "";
    return ok(`Effort (agent=${agent}): ${value}${lock}`);
  }

  function unavailable(capability: string): SelfConfigResult {
    return err(`${capability} is not available in this host.`);
  }

  function scheduleContinue(
    ctx: SelfConfigContext,
    delaySeconds: number,
    message: string,
    nowMs = Date.now(),
  ): SelfConfigResult {
    if (!host.schedules) return unavailable("Self-scheduling");
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;
    if (
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 1 ||
      delaySeconds > product.scheduleMaxDelaySeconds
    ) {
      return err(`delay_seconds must be an integer from 1 to ${product.scheduleMaxDelaySeconds}.`);
    }
    const cleanMessage = message.trim();
    if (!cleanMessage) return err("message is required.");
    if (cleanMessage.length > product.scheduleMaxMessageLength) {
      return err(`message must be ${product.scheduleMaxMessageLength} characters or fewer.`);
    }

    const deliverAtMs = nowMs + delaySeconds * 1000;
    const created = host.schedules.create({
      topicId: topic.id,
      userId: ctx.userId,
      message: cleanMessage,
      deliverAt: deliverAtMs,
      now: nowMs,
    });
    if (!created.ok) {
      return err(
        `This topic already has a pending self-schedule (${created.existing.id}) for ` +
          `${new Date(created.existing.deliverAt).toISOString()}. ` +
          "Use update_self_schedule or cancel_self_schedule instead of creating another one.",
      );
    }
    return ok(
      `Scheduled this topic to resume in ${delaySeconds} seconds at ${new Date(deliverAtMs).toISOString()}. ` +
        `Schedule ID: ${created.schedule.id}. ` +
        `The continuation is durable across node restarts (delivery granularity is about 5 seconds).`,
    );
  }

  function getSchedule(ctx: SelfConfigContext, nowMs = Date.now()): SelfConfigResult {
    if (!host.schedules) return unavailable("Self-scheduling");
    const topic = requireAccessibleTopic(ctx);
    if ("text" in topic) return topic;
    const schedule = host.schedules.getPending(topic.id);
    if (!schedule) return ok("This topic has no pending self-schedule.");
    const remainingSeconds = Math.max(0, Math.ceil((schedule.deliverAt - nowMs) / 1000));
    return ok(
      [
        `Pending self-schedule: ${schedule.id}`,
        `Deliver at: ${new Date(schedule.deliverAt).toISOString()} (in about ${remainingSeconds} seconds)`,
        `Message: ${schedule.message}`,
      ].join("\n"),
    );
  }

  function updateSchedule(
    ctx: SelfConfigContext,
    scheduleId: string,
    updates: { delaySeconds?: number; message?: string },
    nowMs = Date.now(),
  ): SelfConfigResult {
    if (!host.schedules) return unavailable("Self-scheduling");
    const topic = requireAccessibleTopic(ctx);
    if ("text" in topic) return topic;
    if (updates.delaySeconds === undefined && updates.message === undefined) {
      return err("Provide delay_seconds, message, or both.");
    }
    if (
      updates.delaySeconds !== undefined &&
      (!Number.isInteger(updates.delaySeconds) ||
        updates.delaySeconds < 1 ||
        updates.delaySeconds > product.scheduleMaxDelaySeconds)
    ) {
      return err(`delay_seconds must be an integer from 1 to ${product.scheduleMaxDelaySeconds}.`);
    }
    let cleanMessage: string | undefined;
    if (updates.message !== undefined) {
      cleanMessage = updates.message.trim();
      if (!cleanMessage) return err("message is required when provided.");
      if (cleanMessage.length > product.scheduleMaxMessageLength) {
        return err(`message must be ${product.scheduleMaxMessageLength} characters or fewer.`);
      }
    }

    const updated = host.schedules.update({
      topicId: topic.id,
      scheduleId,
      message: cleanMessage,
      deliverAt:
        updates.delaySeconds === undefined ? undefined : nowMs + updates.delaySeconds * 1000,
      now: nowMs,
    });
    if (!updated) {
      return err(
        `Pending self-schedule '${scheduleId}' was not found. It may have been cancelled, replaced, or already started.`,
      );
    }
    return ok(
      `Updated self-schedule ${updated.id}. It will resume at ${new Date(updated.deliverAt).toISOString()}.`,
    );
  }

  function cancelSchedule(ctx: SelfConfigContext, scheduleId: string): SelfConfigResult {
    if (!host.schedules) return unavailable("Self-scheduling");
    const topic = requireAccessibleTopic(ctx);
    if ("text" in topic) return topic;
    if (!host.schedules.cancel(topic.id, scheduleId)) {
      return err(
        `Pending self-schedule '${scheduleId}' was not found. It may have been cancelled, replaced, or already started.`,
      );
    }
    return ok(`Cancelled self-schedule ${scheduleId}.`);
  }

  async function deriveTopic(
    ctx: SelfConfigContext,
    copyHistory: boolean,
    name?: string,
  ): Promise<SelfConfigResult> {
    if (!host.derivedTopics) return unavailable("Derived topics");
    const topic = requireTopic(ctx);
    if ("text" in topic) return topic;

    let derived: SelfConfigTopic | null;
    try {
      derived = await host.derivedTopics.create(topic.id, ctx.userId, copyHistory, { name });
    } catch (error) {
      if (host.derivedTopics.isTitleConflict(error)) {
        return err(`${errorMessage(error)} — pick a different name.`);
      }
      if (copyHistory && host.derivedTopics.isForkCompactionError(error)) {
        return err(errorMessage(error));
      }
      throw error;
    }
    const verb = copyHistory ? "Forked" : "Spawned";
    if (!derived) {
      return err(`Failed to ${verb.toLowerCase()} topic (source not found or permission denied).`);
    }
    const history = copyHistory ? " History copied." : "";
    return ok(
      `${verb} new topic "${derived.title}".${history}\nLink: ${host.derivedTopics.link(derived.id)}`,
    );
  }

  const core: SelfConfigCore = {
    host,
    product,
    setModel,
    getModel,
    setAgent,
    getAgent,
    setEffort,
    getEffort,
    scheduleContinue,
    getSchedule,
    updateSchedule,
    cancelSchedule,
    spawnTopic: (ctx, name) => deriveTopic(ctx, false, name),
    forkTopic: (ctx, name) => deriveTopic(ctx, true, name),
  };
  return Object.freeze(core);
}

export const defaultSelfConfigHost: SelfConfigHost = {
  topics: {
    getTopic,
    getConfig: getApiTopicConfig,
    setConfig: setApiTopicConfig,
  },
  models: {
    forAgent(agent) {
      const registry = getRegistry(agent);
      return {
        defaultEffort: registry.defaultEffort,
        validEfforts: registry.validEfforts,
        validateModel: (model) => registry.validateModel(model),
        validateEffort: (effort) => registry.validateEffort(effort),
        resolveModel: (model) => resolveModelForAgent(agent, model, registry),
      };
    },
    owner: modelOwner,
    checkAuth: (agent, model, userId) => checkAgentModelAuth(agent, model, undefined, userId),
  },
  runtime: {
    resolveWorkspaceDir: resolveTopicWorkspaceDir,
    switchAgent: switchApiTopicAgent,
    configChanged: (topicId) => WsHub.get().broadcastTopicUpdated(topicId),
  },
  derivedTopics: {
    async create(sourceTopicId, userId, copyHistory, options) {
      const { createDerivedTopic } = await import("#topics/derive");
      return createDerivedTopic(sourceTopicId, userId, copyHistory, options);
    },
    link: topicMarkdownLink,
    isTitleConflict: (error) => error instanceof Error && error.name === "TopicTitleConflictError",
    isForkCompactionError: (error) =>
      error instanceof Error && error.name === "TopicForkCompactionError",
  },
  schedules: {
    create: createPendingSelfSchedule,
    getPending: getPendingSelfSchedule,
    update: updatePendingSelfSchedule,
    cancel: cancelPendingSelfSchedule,
  },
};

export const defaultSelfConfigCore = createSelfConfigCore(defaultSelfConfigHost);

export function setSelfConfigModel(ctx: SelfConfigContext, model: string): SelfConfigResult {
  return defaultSelfConfigCore.setModel(ctx, model);
}

export function getSelfConfigModel(ctx: SelfConfigContext): SelfConfigResult {
  return defaultSelfConfigCore.getModel(ctx);
}

export function setSelfConfigAgent(ctx: SelfConfigContext, agent: AgentKind): SelfConfigResult {
  return defaultSelfConfigCore.setAgent(ctx, agent);
}

export function getSelfConfigAgent(ctx: SelfConfigContext): SelfConfigResult {
  return defaultSelfConfigCore.getAgent(ctx);
}

export function setSelfConfigEffort(ctx: SelfConfigContext, effort: EffortLevel): SelfConfigResult {
  return defaultSelfConfigCore.setEffort(ctx, effort);
}

export function getSelfConfigEffort(ctx: SelfConfigContext): SelfConfigResult {
  return defaultSelfConfigCore.getEffort(ctx);
}

export function scheduleSelfConfigContinue(
  ctx: SelfConfigContext,
  delaySeconds: number,
  message: string,
  nowMs = Date.now(),
): SelfConfigResult {
  return defaultSelfConfigCore.scheduleContinue(ctx, delaySeconds, message, nowMs);
}

export function getSelfConfigSchedule(
  ctx: SelfConfigContext,
  nowMs = Date.now(),
): SelfConfigResult {
  return defaultSelfConfigCore.getSchedule(ctx, nowMs);
}

export function updateSelfConfigSchedule(
  ctx: SelfConfigContext,
  scheduleId: string,
  updates: { delaySeconds?: number; message?: string },
  nowMs = Date.now(),
): SelfConfigResult {
  return defaultSelfConfigCore.updateSchedule(ctx, scheduleId, updates, nowMs);
}

export function cancelSelfConfigSchedule(
  ctx: SelfConfigContext,
  scheduleId: string,
): SelfConfigResult {
  return defaultSelfConfigCore.cancelSchedule(ctx, scheduleId);
}

export function spawnSelfConfigTopic(
  ctx: SelfConfigContext,
  name?: string,
): Promise<SelfConfigResult> {
  return defaultSelfConfigCore.spawnTopic(ctx, name);
}

export function forkSelfConfigTopic(
  ctx: SelfConfigContext,
  name?: string,
): Promise<SelfConfigResult> {
  return defaultSelfConfigCore.forkTopic(ctx, name);
}
