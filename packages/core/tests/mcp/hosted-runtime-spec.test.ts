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
  });
});
