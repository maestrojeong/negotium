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
type ApiError = SystemOf<"api_retry">["error"];
type RateLimitType = NonNullable<RateLimitEvent["rate_limit_info"]["rateLimitType"]>;

// Exhaustive over the SDK unions, so a new reason or limit fails `tsc`.
const API_ERROR_TEXT: Record<ApiError, string> = {
  overloaded: "Claude is overloaded",
  rate_limit: "Claude rate limit hit",
  server_error: "Claude API error",
  unknown: "Claude request failed",
  authentication_failed: "Claude sign-in failed",
  oauth_org_not_allowed: "Organization not allowed for Claude",
  account_on_hold: "Claude account is on hold",
  verification_required: "Claude account needs verification",
  billing_error: "Claude billing issue",
  invalid_request: "Claude rejected the request",
  model_not_found: "Claude model not found",
  max_output_tokens: "Claude reply hit the length limit",
  cloud_credential_error: "Cloud credentials failed",
};

const RATE_LIMIT_TEXT: Record<RateLimitType, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

const DENIAL_TEXT: Record<string, string> = {
  rule: "by a permission rule",
  mode: "by the permission mode",
  classifier: "by the safety check",
  asyncAgent: "for a background agent",
};

/** `claude-opus-5-5` → `Opus 5.5`; other ids pass through unchanged. */
function modelLabel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (!match) return id;
  const [, family = "", major, minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

const SYSTEM_NOTICES: {
  [S in SystemSubtype]?: (message: SystemOf<S>) => string | undefined;
} = {
  api_retry: (m) => {
    const reason =
      m.error_status === null
        ? "Lost connection to Claude"
        : (API_ERROR_TEXT[m.error] ?? "Claude request failed");
    const delay = Math.round(m.retry_delay_ms / 1000);
    const when = delay > 0 ? `in ${delay}s` : "now";
    return `${reason} · retrying ${when} (${m.attempt}/${m.max_retries})`;
  },
  model_refusal_fallback: (m) =>
    m.direction === "retry"
      ? `${modelLabel(m.original_model)} declined · ${modelLabel(m.fallback_model)} is answering instead`
      : m.content || undefined,
  model_refusal_no_fallback: (m) => `${modelLabel(m.original_model)} declined this request`,
  permission_denied: (m) => {
    const tool = m.tool_name.split("__").at(-1) || m.tool_name;
    const why = m.decision_reason
      ? `: ${m.decision_reason}`
      : ` ${DENIAL_TEXT[m.decision_reason_type ?? ""] ?? ""}`.trimEnd();
    return `${tool} was blocked${why}`;
  },
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
  const limit = rateLimitType ? `${RATE_LIMIT_TEXT[rateLimitType] ?? ""} `.trimStart() : "";
  if (status === "allowed_warning") return `Nearing your ${limit}Claude usage limit`;
  if (status === "rejected") return `Reached your ${limit}Claude usage limit`;
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
