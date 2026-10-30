import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeNoticeStatus } from "#agents/claude-notices";

/** Fixtures are partial SDK payloads; the mapping only reads a few fields. */
const notice = (message: Record<string, unknown>) =>
  claudeNoticeStatus(message as unknown as SDKMessage);

describe("claudeNoticeStatus", () => {
  test("describes API retries", () => {
    expect(
      notice({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 4_200,
        error_status: 529,
        error: "overloaded",
      }),
    ).toBe("Retrying API request (overloaded, attempt 2/10, in 4s)");
  });

  test("describes model refusals", () => {
    expect(
      notice({
        type: "system",
        subtype: "model_refusal_fallback",
        direction: "retry",
        original_model: "claude-opus-5-5",
        fallback_model: "claude-sonnet-5-5",
        content: "",
      }),
    ).toBe("claude-opus-5-5 declined; retrying with claude-sonnet-5-5");
    expect(
      notice({
        type: "system",
        subtype: "model_refusal_no_fallback",
        original_model: "claude-opus-5-5",
        content: "The model declined this request.",
      }),
    ).toBe("The model declined this request.");
  });

  test("describes auto-denied tool calls", () => {
    expect(
      notice({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "t1",
        decision_reason: "blocked by rule",
        message: "denied",
      }),
    ).toBe("Denied Bash: blocked by rule");
  });

  test("shows only prominent informational messages", () => {
    const info = (level: string, extra: Record<string, unknown> = {}) =>
      notice({
        type: "system",
        subtype: "informational",
        content: "hook said no",
        level,
        ...extra,
      });
    expect(info("warning")).toBe("hook said no");
    expect(info("suggestion")).toBe("hook said no");
    expect(info("info")).toBeUndefined();
    expect(info("notice", { prevent_continuation: true })).toBe("hook said no");
  });

  test("warns only when the rate limit is close or reached", () => {
    const rateLimit = (status: string) =>
      notice({
        type: "rate_limit_event",
        rate_limit_info: { status, rateLimitType: "five_hour" },
      });
    expect(rateLimit("allowed")).toBeUndefined();
    expect(rateLimit("allowed_warning")).toBe("Approaching the Claude usage limit (five_hour)");
    expect(rateLimit("rejected")).toBe("Claude usage limit reached (five_hour)");
  });

  test("ignores unknown and malformed messages instead of failing", () => {
    expect(notice({ type: "system", subtype: "brand_new_subtype", payload: 1 })).toBeUndefined();
    expect(notice({ type: "brand_new_type" })).toBeUndefined();
    expect(
      notice({ type: "system", subtype: "mirror_error", error: "store down" }),
    ).toBeUndefined();
    expect(notice({ type: "rate_limit_event" })).toBeUndefined();
  });
});
