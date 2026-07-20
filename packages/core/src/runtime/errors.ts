import { AGENT_DISPLAY_NAME } from "#agents/model-catalog";
import type { AgentKind } from "#types";

export const SESSION_EXPIRED_MSG = "No conversation found with session ID";

export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return "Unknown agent error";
  }
}

export function authRecoveryHint(agent: AgentKind): string {
  switch (agent) {
    case "claude":
      return "Please refresh your Claude Code login";
    case "codex":
      return "Please log in again with `codex login` (~/.codex/auth.json)";
    case "maestro":
      return "Please check the DEEPSEEK_API_KEY or MOONSHOT_API_KEY environment variable";
  }
}

export function classifyAgentError(err: unknown, agent: AgentKind): string {
  const name = AGENT_DISPLAY_NAME[agent];
  const hint = authRecoveryHint(agent);
  const ctor =
    typeof err === "object" && err !== null
      ? (err as Record<string, unknown>).constructor?.name
      : undefined;
  if (ctor === "AuthenticationError") return `${name} authentication expired. ${hint}. (401)`;
  if (ctor === "RateLimitError")
    return `${name} request limit exceeded. Please try again in a moment. (429)`;
  if (ctor === "InternalServerError") {
    const status = (err as Record<string, unknown>).status;
    return status === 529
      ? `${name} server is overloaded. Please try again in a moment. (529)`
      : `${name} server error occurred. Please try again in a moment. (500)`;
  }

  const s = stringifyError(err);
  if (
    /401|authentication.error|invalid.*api.key|not logged|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|MOONSHOT_API_KEY/i.test(
      s,
    )
  ) {
    return `${name} authentication expired. ${hint}. (401)`;
  }
  if (/429|rate.limit/i.test(s))
    return `${name} request limit exceeded. Please try again in a moment. (429)`;
  if (/529|overloaded/i.test(s))
    return `${name} server is overloaded. Please try again in a moment. (529)`;
  if (/500|internal.server/i.test(s))
    return `${name} server error occurred. Please try again in a moment. (500)`;

  const snippet = s.length > 200 ? `${s.slice(0, 200)}...` : s;
  return `${name} error: ${snippet}`;
}

export function isSessionExpiredError(message: string): boolean {
  return (
    message.includes(SESSION_EXPIRED_MSG) ||
    /session was recorded with model .+ but is resuming with/i.test(message) ||
    /session.*not found|session.*expired|unknown conversation/i.test(message)
  );
}
