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
    ).toBe("Claude is overloaded · retrying in 4s (2/10)");
  });

  test("explains dropped connections and retries without a delay", () => {
    expect(
      notice({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 0,
        error_status: null,
        error: "unknown",
      }),
    ).toBe("Lost connection to Claude · retrying now (1/10)");
  });

  test("names the blocked tool and why", () => {
    expect(
      notice({
        type: "system",
        subtype: "permission_denied",
        tool_name: "mcp__browser__navigate",
        tool_use_id: "t2",
        decision_reason_type: "rule",
        message: "denied",
      }),
    ).toBe("navigate was blocked by a permission rule");
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
    ).toBe("Opus 5.5 declined · Sonnet 5.5 is answering instead");
    expect(
      notice({
        type: "system",
        subtype: "model_refusal_no_fallback",
        original_model: "claude-opus-5-5",
        content: "The model declined this request.",
      }),
    ).toBe("Opus 5.5 declined this request");
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
    ).toBe("Bash was blocked: blocked by rule");
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
    expect(rateLimit("allowed_warning")).toBe("Nearing your 5-hour Claude usage limit");
    expect(rateLimit("rejected")).toBe("Reached your 5-hour Claude usage limit");
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
