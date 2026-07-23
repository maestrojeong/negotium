/**
 * Regression test for the "stream terminal" change (sonamux a3f0f04).
 *
 * The Claude Agent SDK occasionally emits stray messages after a terminal
 * `result`. Before the fix, `claudeProvider` used `continue` after yielding
 * the result and kept consuming the stream — those stray messages leaked out
 * as ghost replies in the topic. The fix replaces `continue` with `return`
 * so the generator closes immediately on terminal.
 *
 * Approach: mock the SDK to throw if anyone tries to read past the result
 * message. If the provider does the right thing, the throw is unreachable.
 */
import { describe, expect, mock, test } from "bun:test";
import type { AgentQueryOptions } from "#types";

mock.module("#platform/mcp-config", () => ({
  getMcpServersForQuery: () => ({}),
}));

describe("claudeProvider terminal handling", () => {
  test("preserves the SDK error flag on tool results", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-tool-error" };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-error",
                content: "permission denied",
                is_error: true,
              },
            ],
          },
        };
        yield { type: "result", subtype: "success", result: "done", stop_reason: "end_turn" };
      },
    }));

    const { claudeProvider } = await import("#agents/claude-provider");
    const events = [];
    for await (const event of claudeProvider({
      agent: "claude",
      prompt: "do work",
      session: "dev",
      sessionType: "forum",
      systemPrompt: "system",
      cwd: "/tmp",
      userId: "test-user",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "tool-error",
      content: "permission denied",
      isError: true,
    });
  });

  test("emits completed assistant blocks in canonical text/tool order", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-order" };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "prefetched text" },
          },
        };
        yield {
          type: "assistant",
          message: {
            model: "claude-test",
            content: [
              { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
              { type: "text", text: "between tools" },
              { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "ls" } },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "between tools",
          stop_reason: "end_turn",
        };
      },
    }));

    const { claudeProvider } = await import("#agents/claude-provider");
    const events = [];
    for await (const event of claudeProvider({
      agent: "claude",
      prompt: "do work",
      session: "dev",
      sessionType: "forum",
      systemPrompt: "system",
      cwd: "/tmp",
      userId: "test-user",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "session", sessionId: "sess-order" },
      { type: "tool_use", name: "Bash", input: { command: "pwd" }, toolUseId: "tool-1" },
      { type: "text", content: "between tools" },
      { type: "tool_use", name: "Bash", input: { command: "ls" }, toolUseId: "tool-2" },
      {
        type: "result",
        content: "between tools",
        stopReason: "end_turn",
        usage: undefined,
      },
    ]);
  });

  test("stops consuming SDK stream after a `result` message", async () => {
    let consumedPastResult = false;
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        yield {
          type: "assistant",
          message: {
            model: "claude-test",
            content: [],
            usage: {
              input_tokens: 1_000,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 3_000,
              output_tokens: 100,
            },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "done",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
          modelUsage: { "claude-test": { contextWindow: 200_000 } },
        };
        // The provider must close the generator before reaching this point.
        consumedPastResult = true;
        throw new Error("SDK stream consumed after terminal result");
      },
    }));

    const { claudeProvider } = await import("#agents/claude-provider");
    const baseOpts: AgentQueryOptions = {
      agent: "claude",
      prompt: "do work",
      session: "dev",
      sessionType: "forum",
      systemPrompt: "system",
      cwd: "/tmp",
      userId: "test-user",
    };

    const events: Array<{
      type: string;
      usage?: { contextTokens?: number; contextWindow?: number };
    }> = [];
    for await (const event of claudeProvider(baseOpts)) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(["session", "result"]);
    expect(events.at(-1)?.usage).toMatchObject({
      contextTokens: 4_300,
      contextWindow: 200_000,
    });
    expect(consumedPastResult).toBe(false);
  });

  test("stops consuming SDK stream after an error result", async () => {
    let consumedPastError = false;
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-2" };
        yield {
          type: "result",
          subtype: "error",
          errors: ["boom"],
        };
        consumedPastError = true;
        throw new Error("SDK stream consumed after error result");
      },
    }));

    const { claudeProvider } = await import("#agents/claude-provider");
    const baseOpts: AgentQueryOptions = {
      agent: "claude",
      prompt: "do work",
      session: "dev",
      sessionType: "forum",
      systemPrompt: "system",
      cwd: "/tmp",
      userId: "test-user",
    };

    const events: Array<{ type: string }> = [];
    for await (const event of claudeProvider(baseOpts)) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(["session", "error"]);
    expect(consumedPastError).toBe(false);
  });

  test("passes a hard cost cap and surfaces budget exhaustion with usage", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: async function* ({ options }: { options?: Record<string, unknown> }) {
        expect(options?.maxBudgetUsd).toBe(3);
        yield {
          type: "result",
          subtype: "error_max_budget_usd",
          errors: [],
          total_cost_usd: 3.02,
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    }));

    const { claudeProvider } = await import("#agents/claude-provider");
    const events = [];
    for await (const event of claudeProvider({
      agent: "claude",
      prompt: "do work",
      session: "dev",
      sessionType: "forum",
      systemPrompt: "system",
      cwd: "/tmp",
      userId: "test-user",
      maxBudgetUsd: 3,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "error",
        content: "The job reached its cost limit",
        code: "budget_exceeded",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: undefined,
          cacheReadInputTokens: undefined,
          costUsd: 3.02,
        },
      },
    ]);
  });
});
