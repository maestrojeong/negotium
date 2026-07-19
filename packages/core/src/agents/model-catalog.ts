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
  /** User-defined relative intelligence band used for routing across providers. */
  intelligenceTier: "sonnet" | "opus" | "fable";
  /** Compact capability/cost hint safe to inject into every turn and tool schema. */
  routingSummary: string;
  /** Subscription or API basis used when comparing operating cost. */
  accessCost: string;
  /** Marginal per-token rate after included subscription usage, or the API rate. */
  marginalTokenCost: string;
  /** Best available quota estimate; never presented as a provider-guaranteed token cap. */
  estimatedUsage: string;
}

/**
 * Pricing and quota observations were checked on 2026-07-19.
 * Official references:
 * - https://learn.chatgpt.com/docs/pricing
 * - https://help.openai.com/en/articles/20001106
 * - https://support.claude.com/en/articles/11049741-what-is-the-max-plan
 * - https://api-docs.deepseek.com/quick_start/pricing
 * Community token counts are deliberately labelled estimates because providers
 * meter cached input, fresh input, output, reasoning, speed, and model choice
 * differently and may change server-side weights without publishing a token cap.
 */
export const MODEL_COST_RESEARCHED_AT = "2026-07-19";
export const MODEL_COST_ROUTING_SUMMARY =
  "Cost basis (2026-07-19): Codex Pro 20x and Claude Max 20x are each $200/month; DeepSeek Pro is pay-per-token. Relative marginal token cost: DeepSeek Pro << Codex < Claude.";

const CODEX_PRO_20X_COST = "ChatGPT Pro 20x subscription: $200/month";
const CODEX_COMMUNITY_WEEKLY =
  "Community plan-level observation: roughly 2–4B raw/cached tokens per week; fresh-input equivalent is much lower and unstable (low confidence)";
const CLAUDE_MAX_20X_COST = "Claude Max 20x subscription: $200/month";
const CLAUDE_COMMUNITY_SESSION =
  "Community observations vary from roughly 220–250K locally displayed tokens per 5-hour session to billions of cache-heavy raw tokens per week; calibrated reports value a full weekly allowance around $680–$1,900 at API rates. Recent heavy-model reports reach the weekly cap after about 4–5 full sessions (low confidence; not a token cap)";

/**
 * Canonical model picker shared by every channel. Keep this deliberately
 * finite even though the Codex backend accepts arbitrary future model ids:
 * user-facing completion should only promise models we intentionally support.
 */
export const SELECTABLE_MODELS: readonly SelectableModel[] = [
  {
    model: "gpt-5.6-sol",
    agent: "codex",
    description: "Highest-capability Codex route for the hardest agentic coding work.",
    intelligenceTier: "fable",
    routingSummary: "hardest coding work; 5x Codex quota cost",
    accessCost: CODEX_PRO_20X_COST,
    marginalTokenCost: "Codex credits: $5/M uncached input, $0.50/M cached input, $30/M output",
    estimatedUsage: `Official Pro 20x range: 300–1,800 local messages per 5 hours; quota weight 5x Luna. ${CODEX_COMMUNITY_WEEKLY}`,
  },
  {
    model: "gpt-5.6-terra",
    agent: "codex",
    description: "High-capability Codex route for complex coding and reasoning.",
    intelligenceTier: "opus",
    routingSummary: "complex coding and reasoning; 2.5x Codex quota cost",
    accessCost: CODEX_PRO_20X_COST,
    marginalTokenCost: "Codex credits: $2.50/M uncached input, $0.25/M cached input, $15/M output",
    estimatedUsage: `Official Pro 20x range: 400–2,200 local messages per 5 hours; quota weight 2.5x Luna. ${CODEX_COMMUNITY_WEEKLY}`,
  },
  {
    model: "gpt-5.6-luna",
    agent: "codex",
    description: "Default Codex route with strong everyday coding intelligence.",
    intelligenceTier: "sonnet",
    routingSummary: "everyday coding default; lowest Codex quota cost (1x)",
    accessCost: CODEX_PRO_20X_COST,
    marginalTokenCost: "Codex credits: $1/M uncached input, $0.10/M cached input, $6/M output",
    estimatedUsage: `Official Pro 20x range: 1,000–5,600 local messages per 5 hours; lowest Codex quota weight (1x). ${CODEX_COMMUNITY_WEEKLY}`,
  },
  {
    model: "fable",
    agent: "claude",
    description: "Highest-capability Claude route for the hardest and longest-running tasks.",
    intelligenceTier: "fable",
    routingSummary: "hardest long-running work; highest Claude cost; explicit request only",
    accessCost: CLAUDE_MAX_20X_COST,
    marginalTokenCost:
      "Claude API/extra usage: $10/M input, $12.50/M cache write, $1/M cache read, $50/M output",
    estimatedUsage: `${CLAUDE_COMMUNITY_SESSION}; Fable drains weighted quota fastest, so use only on explicit user request. No stable per-model token cap is published.`,
  },
  {
    model: "opus",
    agent: "claude",
    description: "High-capability Claude route for complex reasoning and tool-heavy work.",
    intelligenceTier: "opus",
    routingSummary: "complex reasoning and tool-heavy work; about 2.5x Sonnet marginal cost",
    accessCost: CLAUDE_MAX_20X_COST,
    marginalTokenCost:
      "Claude API/extra usage: $5/M input, $6.25/M cache write, $0.50/M cache read, $25/M output",
    estimatedUsage: `${CLAUDE_COMMUNITY_SESSION}; Opus uses the shared all-model weekly pool more quickly than Sonnet. No stable per-model token cap is published.`,
  },
  {
    model: "sonnet",
    agent: "claude",
    description: "Default Claude route for capable, efficient everyday work.",
    intelligenceTier: "sonnet",
    routingSummary: "capable everyday default; lowest Claude model cost",
    accessCost: CLAUDE_MAX_20X_COST,
    marginalTokenCost:
      "Claude API/extra usage introductory rate: $2/M input, $2.50/M cache write, $0.20/M cache read, $10/M output through 2026-08-31; then $3/M input and $15/M output",
    estimatedUsage: `${CLAUDE_COMMUNITY_SESSION}; Sonnet also has a separate weekly allowance and normally provides the highest Claude throughput. No stable weekly token cap is published.`,
  },
  {
    model: "deepseek-pro",
    agent: "maestro",
    description: "API-priced Sonnet-level route for cost-efficient everyday work.",
    intelligenceTier: "sonnet",
    routingSummary: "cost-efficient everyday work; pay-per-token and cheapest route",
    accessCost: "DeepSeek V4 Pro pay-as-you-go API; no monthly subscription required",
    marginalTokenCost:
      "DeepSeek API: $0.435/M uncached input, $0.003625/M cached input, $0.87/M output",
    estimatedUsage:
      "No subscription token cap; pay per token. Official account concurrency limit is 500 requests.",
  },
];

export function formatSelectableModel(candidate: SelectableModel): string {
  const tier = `${candidate.intelligenceTier[0].toUpperCase()}${candidate.intelligenceTier.slice(1)}`;
  return `${candidate.agent} / \`${candidate.model}\` [${tier}-level]: ${candidate.routingSummary}`;
}

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
