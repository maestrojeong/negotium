/**
 * The explicit-switch gate behind `set_agent`: an agent may move a topic to
 * another backend only when the *person's* current message asked for it.
 *
 * The decision is derived here, once, from the full prompt on the node that
 * mints the per-turn runtime MCP token, and the token then carries only the
 * result ({@link explicitAgentSwitchTargets}) — a bounded list of agent kinds
 * — instead of the prompt itself. That keeps the token small whatever the
 * prompt's length and means a long message cannot push the phrase past a
 * cap and turn a request the user made into a refusal.
 */
import { type AgentKind, SUPPORTED_AGENTS } from "#types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentAliases(agent: AgentKind): string[] {
  switch (agent) {
    case "codex":
      return [
        "codex",
        "코덱스",
        "gpt-6-luna",
        "gpt-6-sol",
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-6-astra",
      ];
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

/** Whether `prompt` explicitly asks to switch this topic to `agent`. */
export function hasExplicitAgentSwitchRequest(
  prompt: string | undefined,
  agent: AgentKind,
): boolean {
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

/**
 * The agents `prompt` explicitly asks to switch to, in {@link SUPPORTED_AGENTS}
 * order — the same test as {@link hasExplicitAgentSwitchRequest}, evaluated for
 * every agent kind over the whole prompt. Empty when nothing was asked for.
 */
export function explicitAgentSwitchTargets(prompt: string | undefined): AgentKind[] {
  if (!prompt?.trim()) return [];
  return SUPPORTED_AGENTS.filter((agent) => hasExplicitAgentSwitchRequest(prompt, agent));
}

/**
 * Shape check for the derived field where it crosses a trust boundary (the
 * signed token): a de-duplicated list of known agent kinds. It cannot hold
 * more entries than there are agents, so its size is fixed.
 */
export function isExplicitAgentSwitchTargets(value: unknown): value is AgentKind[] {
  return (
    Array.isArray(value) &&
    value.length <= SUPPORTED_AGENTS.length &&
    value.every((item, index) => isAgentKindUnique(value, item, index))
  );
}

function isAgentKindUnique(list: unknown[], item: unknown, index: number): boolean {
  return (
    typeof item === "string" &&
    (SUPPORTED_AGENTS as readonly string[]).includes(item) &&
    list.indexOf(item) === index
  );
}
