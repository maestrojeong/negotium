import { z } from "zod";
import { type SharedMcpTool, textResult } from "#agents/mcp-tools/common";
import {
  cancelSelfConfigSchedule,
  forkSelfConfigTopic,
  getSelfConfigAgent,
  getSelfConfigEffort,
  getSelfConfigModel,
  getSelfConfigSchedule,
  SELF_CONFIG_MCP_KEY,
  SELF_SCHEDULE_MAX_DELAY_SECONDS,
  SELF_SCHEDULE_MAX_MESSAGE_LENGTH,
  type SelfConfigContext,
  type SelfConfigResult,
  scheduleSelfConfigContinue,
  setSelfConfigAgent,
  setSelfConfigEffort,
  setSelfConfigModel,
  spawnSelfConfigTopic,
  updateSelfConfigSchedule,
} from "#agents/self-config-core";
import { type AgentKind, EFFORT_VALUES, type EffortLevel, SUPPORTED_AGENTS } from "#types";

export type { SelfConfigContext };
export { SELF_CONFIG_MCP_KEY };

const AGENT_VALUES = SUPPORTED_AGENTS as readonly AgentKind[];
export const SELF_CONFIG_DERIVED_TOPIC_LIMIT = 5;

function mcpResult(result: SelfConfigResult) {
  return {
    ...textResult(result.text),
    ...(result.isError ? { isError: true as const } : {}),
  };
}

function contextGetter(ctx: SelfConfigContext | (() => SelfConfigContext)) {
  return typeof ctx === "function" ? ctx : () => ctx;
}

export function createSelfConfigToolDefinitions(
  ctx: SelfConfigContext | (() => SelfConfigContext),
): SharedMcpTool[] {
  const getCtx = contextGetter(ctx);
  let derivedCount = 0;

  return [
    {
      name: "set_model",
      description:
        "Set the model for THIS topic. Persists and applies from the NEXT turn. Claude: 'sonnet' / 'opus' / 'fable'. Codex: 'gpt-5.6-luna' (default) / 'gpt-5.6-terra' / 'gpt-5.6-sol'. Maestro: 'deepseek-pro' / 'deepseek-flash' / 'deepseek'. The model must match the topic's current agent's accepted list. Switch agent first via set_agent only when crossing the claude/codex/maestro runtime boundary. Fails if the user locked this setting. NEVER use 'fable' unless the user explicitly requests it.",
      schema: { model: z.string().describe("Model id valid for the topic's current agent.") },
      async handler({ model }: { model: string }) {
        return mcpResult(setSelfConfigModel(getCtx(), model));
      },
    },
    {
      name: "get_model",
      description:
        "Get the current model setting for THIS topic and whether it is locked by the user.",
      schema: {},
      async handler() {
        return mcpResult(getSelfConfigModel(getCtx()));
      },
    },
    {
      name: "set_agent",
      description:
        "Switch the agent backend for THIS topic between 'claude', 'codex', and 'maestro'. Clears the topic's model/effort override so the new agent starts at its defaults. Fails if the user locked this setting. Use only when the user explicitly asks to switch the runtime itself.",
      schema: { agent: z.enum(AGENT_VALUES as unknown as [AgentKind, ...AgentKind[]]) },
      async handler({ agent }: { agent: AgentKind }) {
        return mcpResult(setSelfConfigAgent(getCtx(), agent));
      },
    },
    {
      name: "get_agent",
      description: "Get the current agent backend ('claude' / 'codex' / 'maestro') for THIS topic.",
      schema: {},
      async handler() {
        return mcpResult(getSelfConfigAgent(getCtx()));
      },
    },
    {
      name: "set_effort",
      description:
        "Set the reasoning effort for THIS topic. Claude: low/medium/high/xhigh/max. Codex: low/medium/high/xhigh. Maestro: low/medium/high/xhigh/max. Higher effort costs more and is slower. Fails if the user locked this setting.",
      schema: {
        effort: z
          .enum(EFFORT_VALUES)
          .describe("Reasoning effort level valid for the topic's current agent."),
      },
      async handler({ effort }: { effort: EffortLevel }) {
        return mcpResult(setSelfConfigEffort(getCtx(), effort));
      },
    },
    {
      name: "get_effort",
      description:
        "Get the current reasoning effort setting for THIS topic and whether it is locked by the user.",
      schema: {},
      async handler() {
        return mcpResult(getSelfConfigEffort(getCtx()));
      },
    },
    {
      name: "schedule_self",
      description:
        "Create the one pending durable delayed continuation allowed for THIS topic without blocking the current turn. Use it to check a long-running operation or resume work later. The future message must be self-contained. If one already exists, use get_self_schedule then update_self_schedule or cancel_self_schedule. For recurring or longer-lived schedules, use cron-manager instead.",
      schema: {
        delay_seconds: z
          .number()
          .int()
          .min(1)
          .max(SELF_SCHEDULE_MAX_DELAY_SECONDS)
          .describe("Seconds before this topic resumes, from 1 through 86400 (24 hours)."),
        message: z
          .string()
          .min(1)
          .max(SELF_SCHEDULE_MAX_MESSAGE_LENGTH)
          .describe("Self-contained instruction delivered to your future turn."),
      },
      async handler({ delay_seconds, message }: { delay_seconds: number; message: string }) {
        return mcpResult(scheduleSelfConfigContinue(getCtx(), delay_seconds, message));
      },
    },
    {
      name: "get_self_schedule",
      description:
        "Inspect THIS topic's pending one-shot delayed continuation, including its schedule ID, delivery time, and message.",
      schema: {},
      async handler() {
        return mcpResult(getSelfConfigSchedule(getCtx()));
      },
    },
    {
      name: "update_self_schedule",
      description:
        "Edit THIS topic's pending self-schedule. Provide its schedule_id from schedule_self/get_self_schedule and change delay_seconds, message, or both. delay_seconds is measured from this update. A schedule that already started cannot be edited.",
      schema: {
        schedule_id: z.string().min(1).describe("Exact ID of the pending self-schedule."),
        delay_seconds: z
          .number()
          .int()
          .min(1)
          .max(SELF_SCHEDULE_MAX_DELAY_SECONDS)
          .optional()
          .describe("New delay from now, from 1 through 86400 seconds."),
        message: z
          .string()
          .min(1)
          .max(SELF_SCHEDULE_MAX_MESSAGE_LENGTH)
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
          updateSelfConfigSchedule(getCtx(), schedule_id, {
            delaySeconds: delay_seconds,
            message,
          }),
        );
      },
    },
    {
      name: "cancel_self_schedule",
      description:
        "Cancel THIS topic's pending self-schedule by its exact schedule_id. A schedule that already started cannot be cancelled with this tool.",
      schema: {
        schedule_id: z.string().min(1).describe("Exact ID of the pending self-schedule."),
      },
      async handler({ schedule_id }: { schedule_id: string }) {
        return mcpResult(cancelSelfConfigSchedule(getCtx(), schedule_id));
      },
    },
    {
      name: "spawn_topic",
      description:
        "Create a new forum topic that inherits all settings from THIS topic but starts with a fresh session. Limited to 5 calls per conversation turn.",
      schema: {
        name: z.string().optional().describe("New topic name. Auto-generated if omitted."),
      },
      async handler({ name }: { name?: string }) {
        if (derivedCount >= SELF_CONFIG_DERIVED_TOPIC_LIMIT) {
          return mcpResult({
            text: `Limit reached: only ${SELF_CONFIG_DERIVED_TOPIC_LIMIT} spawn/fork calls per conversation turn.`,
            isError: true,
          });
        }
        derivedCount++;
        return mcpResult(await spawnSelfConfigTopic(getCtx(), name));
      },
    },
    {
      name: "fork_topic",
      description:
        "Fork THIS topic by creating a new topic that inherits both settings AND conversation history. Limited to 5 calls per conversation turn.",
      schema: {
        name: z.string().optional().describe("New topic name. Auto-generated if omitted."),
      },
      async handler({ name }: { name?: string }) {
        if (derivedCount >= SELF_CONFIG_DERIVED_TOPIC_LIMIT) {
          return mcpResult({
            text: `Limit reached: only ${SELF_CONFIG_DERIVED_TOPIC_LIMIT} spawn/fork calls per conversation turn.`,
            isError: true,
          });
        }
        derivedCount++;
        return mcpResult(await forkSelfConfigTopic(getCtx(), name));
      },
    },
  ];
}
