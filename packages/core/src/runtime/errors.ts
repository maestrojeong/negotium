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
      return "Claude Code 로그인을 갱신해주세요";
    case "codex":
      return "`codex login` 으로 다시 로그인해주세요 (~/.codex/auth.json)";
    case "maestro":
      return "DEEPSEEK_API_KEY 환경변수를 확인해주세요";
  }
}

export function classifyAgentError(err: unknown, agent: AgentKind): string {
  const name = AGENT_DISPLAY_NAME[agent];
  const hint = authRecoveryHint(agent);
  const ctor =
    typeof err === "object" && err !== null
      ? (err as Record<string, unknown>).constructor?.name
      : undefined;
  if (ctor === "AuthenticationError") return `${name} 인증이 만료되었습니다. ${hint}. (401)`;
  if (ctor === "RateLimitError")
    return `${name} 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요. (429)`;
  if (ctor === "InternalServerError") {
    const status = (err as Record<string, unknown>).status;
    return status === 529
      ? `${name} 서버가 과부하 상태입니다. 잠시 후 다시 시도해주세요. (529)`
      : `${name} 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요. (500)`;
  }

  const s = stringifyError(err);
  if (
    /401|authentication.error|invalid.*api.key|not logged|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY/i.test(
      s,
    )
  ) {
    return `${name} 인증이 만료되었습니다. ${hint}. (401)`;
  }
  if (/429|rate.limit/i.test(s))
    return `${name} 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요. (429)`;
  if (/529|overloaded/i.test(s))
    return `${name} 서버가 과부하 상태입니다. 잠시 후 다시 시도해주세요. (529)`;
  if (/500|internal.server/i.test(s))
    return `${name} 서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요. (500)`;

  const snippet = s.length > 200 ? `${s.slice(0, 200)}...` : s;
  return `${name} 오류: ${snippet}`;
}

export function isSessionExpiredError(message: string): boolean {
  return (
    message.includes(SESSION_EXPIRED_MSG) ||
    /session was recorded with model .+ but is resuming with/i.test(message) ||
    /session.*not found|session.*expired|unknown conversation/i.test(message)
  );
}
