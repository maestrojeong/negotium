import { z } from "zod";
import { type SharedMcpTool, textResult } from "#agents/mcp-tools/common";
import {
  createSelfConfigCore,
  defaultSelfConfigCore,
  SELF_CONFIG_MCP_KEY,
  type SelfConfigContext,
  type SelfConfigCore,
  type SelfConfigHost,
  type SelfConfigProductConfig,
  type SelfConfigResult,
} from "#agents/self-config-core";
import { type AgentKind, EFFORT_VALUES, type EffortLevel, SUPPORTED_AGENTS } from "#types";

export type { SelfConfigContext };
export { SELF_CONFIG_MCP_KEY };

const AGENT_VALUES = SUPPORTED_AGENTS as readonly AgentKind[];
export const SELF_CONFIG_DERIVED_TOPIC_LIMIT = 5;

export interface SelfConfigRuntime {
  readonly core: SelfConfigCore;
  readonly mcpKey: string;
  createToolDefinitions(ctx: SelfConfigContext | (() => SelfConfigContext)): SharedMcpTool[];
}

export interface SelfConfigRuntimeOptions {
  host: SelfConfigHost;
  product?: Partial<SelfConfigProductConfig>;
}

function mcpResult(result: SelfConfigResult) {
  return {
    ...textResult(result.text),
    ...(result.isError ? { isError: true as const } : {}),
  };
}

function contextGetter(ctx: SelfConfigContext | (() => SelfConfigContext)) {
  return typeof ctx === "function" ? ctx : () => ctx;
}

function toolDescription(core: SelfConfigCore, name: string, fallback: string): string {
  return core.product.toolDescriptions[name] ?? fallback;
}

export function createSelfConfigRuntime(options: SelfConfigRuntimeOptions): SelfConfigRuntime {
  const core = createSelfConfigCore(options.host, options.product);
  const runtime: SelfConfigRuntime = {
    core,
    mcpKey: core.product.mcpKey,
    createToolDefinitions: (ctx) => createSelfConfigToolDefinitionsForCore(core, ctx),
  };
  return Object.freeze(runtime);
}

export function createSelfConfigToolDefinitionsForCore(
  core: SelfConfigCore,
  ctx: SelfConfigContext | (() => SelfConfigContext),
): SharedMcpTool[] {
  const getCtx = contextGetter(ctx);
  let derivedCount = 0;

  const tools: SharedMcpTool[] = [
    {
      name: "set_model",
      description: toolDescription(
        core,
        "set_model",
        "Set the model for THIS topic; it persists and applies from the NEXT turn. Use a model from the system prompt's same-agent catalog. Cross-agent changes require an explicit user-requested set_agent first. Fails if the user locked this setting. NEVER use 'fable' unless explicitly requested.",
      ),
      schema: { model: z.string().describe("Model id valid for the topic's current agent.") },
      async handler({ model }: { model: string }) {
        return mcpResult(core.setModel(getCtx(), model));
      },
    },
    {
      name: "get_model",
      description: toolDescription(
        core,
        "get_model",
        "Get the current model setting for THIS topic and whether it is locked by the user.",
      ),
      schema: {},
      async handler() {
        return mcpResult(core.getModel(getCtx()));
      },
    },
    {
      name: "set_agent",
      description: toolDescription(
        core,
        "set_agent",
        "Switch the agent backend for THIS topic between 'claude', 'codex', and 'maestro'. Clears the topic's model/effort override so the new agent starts at its defaults. Fails if the user locked this setting. Use only when the user explicitly asks to switch the runtime itself.",
      ),
      schema: { agent: z.enum(AGENT_VALUES as unknown as [AgentKind, ...AgentKind[]]) },
      async handler({ agent }: { agent: AgentKind }) {
        return mcpResult(core.setAgent(getCtx(), agent));
      },
    },
    {
      name: "get_agent",
      description: toolDescription(
        core,
        "get_agent",
        "Get the current agent backend ('claude' / 'codex' / 'maestro') for THIS topic.",
      ),
      schema: {},
      async handler() {
        return mcpResult(core.getAgent(getCtx()));
      },
    },
    {
      name: "set_effort",
      description: toolDescription(
        core,
        "set_effort",
        "Set the reasoning effort for THIS topic. Claude: low/medium/high/xhigh/max. Codex: low/medium/high/xhigh. Maestro: low/medium/high/xhigh/max. Higher effort costs more and is slower. Fails if the user locked this setting.",
      ),
      schema: {
        effort: z
          .enum(EFFORT_VALUES)
          .describe("Reasoning effort level valid for the topic's current agent."),
      },
      async handler({ effort }: { effort: EffortLevel }) {
        return mcpResult(core.setEffort(getCtx(), effort));
      },
    },
    {
      name: "get_effort",
      description: toolDescription(
        core,
        "get_effort",
        "Get the current reasoning effort setting for THIS topic and whether it is locked by the user.",
      ),
      schema: {},
      async handler() {
        return mcpResult(core.getEffort(getCtx()));
      },
    },
  ];

  if (core.host.schedules) {
    tools.push({
      name: "schedule_self",
      description: toolDescription(
        core,
        "schedule_self",
        "Create the one pending durable delayed continuation allowed for THIS topic without blocking the current turn. Use it to check a long-running operation or resume work later. The future message must be self-contained. If one already exists, use get_self_schedule then update_self_schedule or cancel_self_schedule. For recurring or longer-lived schedules, use cron-manager instead.",
      ),
      schema: {
        delay_seconds: z
          .number()
          .int()
          .min(1)
          .max(core.product.scheduleMaxDelaySeconds)
          .describe(
            `Seconds before this topic resumes, from 1 through ${core.product.scheduleMaxDelaySeconds}${
              core.product.scheduleMaxDelaySeconds === 86_400 ? " (24 hours)" : ""
            }.`,
          ),
        message: z
          .string()
          .min(1)
          .max(core.product.scheduleMaxMessageLength)
          .describe("Self-contained instruction delivered to your future turn."),
      },
      async handler({ delay_seconds, message }: { delay_seconds: number; message: string }) {
        return mcpResult(core.scheduleContinue(getCtx(), delay_seconds, message));
      },
    });
    tools.push({
      name: "get_self_schedule",
      description: toolDescription(
        core,
        "get_self_schedule",
        "Inspect THIS topic's pending one-shot delayed continuation, including its schedule ID, delivery time, and message.",
      ),
      schema: {},
      async handler() {
        return mcpResult(core.getSchedule(getCtx()));
      },
    });
    tools.push({
      name: "update_self_schedule",
      description: toolDescription(
        core,
        "update_self_schedule",
        "Edit THIS topic's pending self-schedule. Provide its schedule_id from schedule_self/get_self_schedule and change delay_seconds, message, or both. delay_seconds is measured from this update. A schedule that already started cannot be edited.",
      ),
      schema: {
        schedule_id: z.string().min(1).describe("Exact ID of the pending self-schedule."),
        delay_seconds: z
          .number()
          .int()
          .min(1)
          .max(core.product.scheduleMaxDelaySeconds)
          .optional()
          .describe(
            `New delay from now, from 1 through ${core.product.scheduleMaxDelaySeconds} seconds.`,
          ),
        message: z
          .string()
          .min(1)
          .max(core.product.scheduleMaxMessageLength)
          .optional()
          .describe("Replacement self-contained future instruction."),
      },
      async handler({
        schedule_id,
        delay_seconds,
        message,
      }: {
        schedule_id: string;
        delay_seconds?: number;
        message?: string;
      }) {
        return mcpResult(
          core.updateSchedule(getCtx(), schedule_id, {
            delaySeconds: delay_seconds,
            message,
          }),
        );
      },
    });
    tools.push({
      name: "cancel_self_schedule",
      description: toolDescription(
        core,
        "cancel_self_schedule",
        "Cancel THIS topic's pending self-schedule by its exact schedule_id. A schedule that already started cannot be cancelled with this tool.",
      ),
      schema: {
        schedule_id: z.string().min(1).describe("Exact ID of the pending self-schedule."),
      },
      async handler({ schedule_id }: { schedule_id: string }) {
        return mcpResult(core.cancelSchedule(getCtx(), schedule_id));
      },
    });
  }

  if (core.host.derivedTopics) {
    tools.push({
      name: "spawn_topic",
      description: toolDescription(
        core,
        "spawn_topic",
        `Create a new forum topic that inherits all settings from THIS topic but starts with a fresh session. Limited to ${core.product.derivedTopicLimit} calls per conversation turn.`,
      ),
      schema: {
        name: z.string().optional().describe("New topic name. Auto-generated if omitted."),
      },
      async handler({ name }: { name?: string }) {
        if (derivedCount >= core.product.derivedTopicLimit) {
          return mcpResult({
            text: `Limit reached: only ${core.product.derivedTopicLimit} spawn/fork calls per conversation turn.`,
            isError: true,
          });
        }
        derivedCount++;
        return mcpResult(await core.spawnTopic(getCtx(), name));
      },
    });
    tools.push({
      name: "fork_topic",
      description: toolDescription(
        core,
        "fork_topic",
        `Fork THIS topic by creating a new topic that inherits both settings AND conversation history. Limited to ${core.product.derivedTopicLimit} calls per conversation turn.`,
      ),
      schema: {
        name: z.string().optional().describe("New topic name. Auto-generated if omitted."),
      },
      async handler({ name }: { name?: string }) {
        if (derivedCount >= core.product.derivedTopicLimit) {
          return mcpResult({
            text: `Limit reached: only ${core.product.derivedTopicLimit} spawn/fork calls per conversation turn.`,
            isError: true,
          });
        }
        derivedCount++;
        return mcpResult(await core.forkTopic(getCtx(), name));
      },
    });
  }

  return tools;
}

export function createSelfConfigToolDefinitions(
  ctx: SelfConfigContext | (() => SelfConfigContext),
): SharedMcpTool[] {
  return createSelfConfigToolDefinitionsForCore(defaultSelfConfigCore, ctx);
}
