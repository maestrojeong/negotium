import { resolveDefaultModel } from "#platform/config";
import type { AgentKind } from "#types";

/**
 * Models/prefixes that belong exclusively to one agent backend. When the
 * resolved agent differs from a model's owner, the model is cross-agent stale
 * and must be dropped in favor of the new agent's default — otherwise the value
 * is passed straight into a provider that can't run it and crashes the turn
 * (bug B: `/codex` leaves the topic's "sonnet" behind → Codex 400
 * "The 'sonnet' model is not supported when using Codex").
 *
 * Codex's own `validateModel` accepts ANY non-empty string (OpenAI ships new
 * IDs frequently), so it can't reject "sonnet" on its own — this ownership
 * owner check is the cross-agent guard the per-registry validator can't provide.
 * Unknown/new model IDs are intentionally absent here so they still pass
 * through to whichever agent is active.
 */
export const MODEL_OWNER: Record<string, AgentKind> = {
  // Current aliases plus retired aliases retained only for stale-model detection.
  sonnet: "claude",
  opus: "claude",
  haiku: "claude",
  fable: "claude",
  "gpt-5.6-luna": "codex",
  "gpt-5.6-terra": "codex",
  "gpt-5.6-sol": "codex",
  "gpt-5.5": "codex",
  deepseek: "maestro",
  "deepseek-pro": "maestro",
  "deepseek-flash": "maestro",
};

export interface SelectableModel {
  /** Canonical token accepted by user-facing `/model` commands. */
  model: string;
  /** Runtime owner kept internal so channel UIs only need to show `model`. */
  agent: AgentKind;
  /** Short comparison copy shown alongside the model in picker UIs. */
  description: string;
}

/**
 * Canonical model picker shared by every channel. Keep this deliberately
 * finite even though the Codex backend accepts arbitrary future model ids:
 * user-facing completion should only promise models we intentionally support.
 */
export const SELECTABLE_MODELS: readonly SelectableModel[] = [
  {
    model: "gpt-5.6-sol",
    agent: "codex",
    description: "Latest frontier agentic coding model.",
  },
  {
    model: "gpt-5.6-terra",
    agent: "codex",
    description: "Balanced agentic coding model for everyday work.",
  },
  {
    model: "gpt-5.6-luna",
    agent: "codex",
    description: "Fast and affordable agentic coding model.",
  },
  {
    model: "gpt-5.5",
    agent: "codex",
    description: "Frontier model for complex coding, research, and real-world work.",
  },
  {
    model: "fable",
    agent: "claude",
    description:
      "Fable 5 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok",
  },
  {
    model: "opus",
    agent: "claude",
    description: "Opus 4.8 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok",
  },
  {
    model: "sonnet",
    agent: "claude",
    description: "Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok · promo through Aug 31",
  },
  {
    model: "deepseek-pro",
    agent: "maestro",
    description: "Sonnet-level performance at lower cost · Best for everyday tasks over coding",
  },
  {
    model: "deepseek-flash",
    agent: "maestro",
    description: "DeepSeek V4 Flash · Fast and low-cost for lightweight everyday tasks",
  },
];

export function selectableModel(value: string): SelectableModel | undefined {
  const normalized = value.trim().toLowerCase();
  return SELECTABLE_MODELS.find((candidate) => candidate.model === normalized);
}

export function modelOwner(model: string): AgentKind | undefined {
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("deepseek-")) return "maestro";
  if (model.startsWith("gpt-")) return "codex";
  return MODEL_OWNER[model];
}

/**
 * Resolve the model to run for `agent`, given the requested value from the
 * priority chain (per-message slash > topic-config override > topic default).
 * Drops a model owned by a different agent, then falls back to the agent's
 * registry default if the value is empty/invalid for this agent.
 */
export function resolveModelForAgent(
  agent: AgentKind,
  requested: string | undefined,
  registry: { validateModel(s: string): boolean; defaultModel: string },
): string {
  const defaultModel = resolveDefaultModel(agent, registry.defaultModel);
  if (!requested) return defaultModel;
  const owner = modelOwner(requested);
  if (owner && owner !== agent) return defaultModel; // cross-agent stale
  return registry.validateModel(requested) ? requested : defaultModel;
}

/**
 * Circular fallback order per agent. Each entry lists candidates to try in
 * priority order when the current agent errors out. The actual switch is
 * guarded by `checkAgentAuth` — only candidates whose backend is reachable
 * (API key present / auth file exists) will be selected.
 */
export const FALLBACK_ORDER: Record<AgentKind, { agent: AgentKind; model: string }[]> = {
  claude: [
    { agent: "maestro", model: "deepseek-pro" },
    { agent: "codex", model: "gpt-5.6-luna" },
  ],
  codex: [
    { agent: "maestro", model: "deepseek-pro" },
    { agent: "claude", model: "sonnet" },
  ],
  maestro: [
    { agent: "codex", model: "gpt-5.6-luna" },
    { agent: "claude", model: "sonnet" },
  ],
};

export const AGENT_DISPLAY_NAME: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  maestro: "Maestro",
};
