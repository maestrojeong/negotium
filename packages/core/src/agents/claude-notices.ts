/**
 * Non-fatal Claude Agent SDK notices → user-visible status lines.
 *
 * Fatality is decided only by the terminal `result` message or a CLI exit
 * (see claude-provider.ts); nothing here may end a turn. The SDK adds and
 * renames system subtypes often, so the handled subtypes are keyed by the
 * SDK's own types: a rename or removal fails `tsc` on upgrade, while a
 * subtype this table does not know is only debug-logged at runtime.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "#platform/logger";

type SystemMessage = Extract<SDKMessage, { type: "system" }>;
type SystemSubtype = SystemMessage["subtype"];
type SystemOf<S extends SystemSubtype> = Extract<SystemMessage, { subtype: S }>;
type RateLimitEvent = Extract<SDKMessage, { type: "rate_limit_event" }>;

const SYSTEM_NOTICES: {
  [S in SystemSubtype]?: (message: SystemOf<S>) => string | undefined;
} = {
  api_retry: (m) => {
    const delay = Math.max(0, Math.round(m.retry_delay_ms / 1000));
    return `Retrying API request (${m.error}, attempt ${m.attempt}/${m.max_retries}, in ${delay}s)`;
  },
  model_refusal_fallback: (m) =>
    m.direction === "retry"
      ? `${m.original_model} declined; retrying with ${m.fallback_model}`
      : m.content || undefined,
  model_refusal_no_fallback: (m) => m.content || `${m.original_model} declined to respond`,
  permission_denied: (m) =>
    `Denied ${m.tool_name}${m.decision_reason ? `: ${m.decision_reason}` : ""}`,
  informational: (m) =>
    m.prevent_continuation || m.level === "warning" || m.level === "suggestion"
      ? m.content
      : undefined,
  mirror_error: (m) => {
    logger.warn({ error: m.error }, "claudeProvider: transcript mirror batch dropped");
    return undefined;
  },
};

function rateLimitNotice(m: RateLimitEvent): string | undefined {
  const { status, rateLimitType } = m.rate_limit_info;
  const scope = rateLimitType ? ` (${rateLimitType})` : "";
  if (status === "allowed_warning") return `Approaching the Claude usage limit${scope}`;
  if (status === "rejected") return `Claude usage limit reached${scope}`;
  return undefined;
}

/**
 * Status text for a non-terminal SDK message, or undefined when it should not
 * be shown. Never throws and never classifies anything as an error.
 */
export function claudeNoticeStatus(message: SDKMessage): string | undefined {
  try {
    if (message.type === "rate_limit_event") return rateLimitNotice(message);
    if (message.type !== "system") return undefined;
    const handler = SYSTEM_NOTICES[message.subtype] as
      | ((m: SystemMessage) => string | undefined)
      | undefined;
    if (!handler) {
      logger.debug(
        { subtype: message.subtype, msg: message },
        "claudeProvider: system message (unhandled subtype)",
      );
      return undefined;
    }
    const status = handler(message);
    if (status) logger.warn({ subtype: message.subtype, status }, "claudeProvider: notice");
    return status;
  } catch (err) {
    // A field reshaped by an SDK upgrade must not take the turn down with it.
    logger.debug({ err, msg: message }, "claudeProvider: notice mapping failed");
    return undefined;
  }
}
