import { describe, expect, test } from "bun:test";
import {
  buildHostedMcpSpec,
  type HostedMcpContext,
  issueHostedMcpToken,
  resolveHostedMcpToken,
  setRuntimeMcpPort,
} from "#mcp/runtime-spec";

const context: HostedMcpContext = {
  userId: "local",
  topicTitle: "design",
  cwd: "/tmp/design",
  agent: "codex",
};

describe("hosted MCP runtime spec", () => {
  test("binds a signed token to one surface while allowing DM context", () => {
    const token = issueHostedMcpToken("wiki", context);
    expect(resolveHostedMcpToken(token, "wiki")).toEqual(context);
    expect(resolveHostedMcpToken(token, "vault")).toBeNull();
  });

  test("rejects a modified signature", () => {
    const token = issueHostedMcpToken("task", context);
    const replacement = token.endsWith("a") ? "b" : "a";
    const forged = `${token.slice(0, -1)}${replacement}`;
    expect(resolveHostedMcpToken(forged, "task")).toBeNull();
  });

  test("builds streamable HTTP for Codex and SSE for other agents", () => {
    setRuntimeMcpPort(45678);
    const codex = buildHostedMcpSpec("codex", "task", context);
    const claude = buildHostedMcpSpec("claude", "task", { ...context, agent: "claude" });

    expect(String(codex.url)).toStartWith("http://127.0.0.1:45678/mcp/runtime/task/mcp?token=");
    expect(claude.type).toBe("sse");
    expect(String(claude.url)).toStartWith("http://127.0.0.1:45678/mcp/runtime/task/sse?token=");
    expect(claude.cacheKey).toBeUndefined();
    expect(claude.lifecycle).toBeUndefined();
  });

  test("gives Maestro a stable semantic identity independent of per-turn tokens", () => {
    const first = buildHostedMcpSpec("maestro", "wiki", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
      queryId: "query-1",
    });
    const second = buildHostedMcpSpec("maestro", "wiki", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
      queryId: "query-2",
    });

    expect(first.lifecycle).toBe("process");
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.cacheKey).toStartWith("hosted:wiki:");
    expect(first.url).not.toBe(second.url);
  });

  test("keeps context-sensitive hosted identities isolated", () => {
    const first = buildHostedMcpSpec("maestro", "task", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
    });
    const second = buildHostedMcpSpec("maestro", "task", {
      ...context,
      agent: "maestro",
      topicId: "topic-2",
    });
    expect(first.cacheKey).not.toBe(second.cacheKey);
  });

  test("marks normal session-comm as session state and query-bound bridges as turn state", () => {
    const normal = buildHostedMcpSpec("maestro", "session-comm", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
    });
    const replyOnly = buildHostedMcpSpec("maestro", "session-comm", {
      ...context,
      agent: "maestro",
      topicId: "topic-1",
      silent: true,
    });

    expect(normal.lifecycle).toBe("session");
    expect(replyOnly.lifecycle).toBe("turn");
  });
});
