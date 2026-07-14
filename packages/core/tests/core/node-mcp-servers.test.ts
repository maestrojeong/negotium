import { afterEach, describe, expect, test } from "bun:test";
import { getForumMcpServers, setNodeMcpServers } from "#platform/mcp-config";

afterEach(() => setNodeMcpServers([]));

describe("node-assigned MCP servers (manifest wiring)", () => {
  test("http entry rides the forum catalog with per-agent transport", () => {
    setNodeMcpServers([{ key: "browser2", kind: "http", port: 9155 }]);

    const claude = getForumMcpServers({ userId: "u", session: "t", agent: "claude" });
    expect(claude.browser2).toEqual({ type: "sse", url: "http://127.0.0.1:9155/sse" });

    const codex = getForumMcpServers({ userId: "u", session: "t", agent: "codex" });
    expect(codex.browser2).toEqual({ url: "http://127.0.0.1:9155/mcp" });
  });

  test("stdio entry passes through command/args/env", () => {
    setNodeMcpServers([
      { key: "mytool", kind: "stdio", command: "bunx", args: ["mytool-mcp"], env: { A: "1" } },
    ]);
    const servers = getForumMcpServers({ userId: "u", session: "t", agent: "claude" });
    expect(servers.mytool).toEqual({ command: "bunx", args: ["mytool-mcp"], env: { A: "1" } });
  });

  test("per-topic enabled whitelist filters node MCPs like optional built-ins", () => {
    setNodeMcpServers([{ key: "browser2", kind: "http", port: 9155 }]);
    const servers = getForumMcpServers({
      userId: "u",
      session: "t",
      agent: "claude",
      enabled: ["wiki"],
    });
    expect(servers.browser2).toBeUndefined();
  });

  test("entries shadowing built-in catalog keys are ignored", () => {
    setNodeMcpServers([{ key: "wiki", kind: "http", port: 9155 }]);
    const servers = getForumMcpServers({ userId: "u", session: "t", agent: "claude" });
    // built-in wiki (stdio launch shape) must win over the impostor
    expect((servers.wiki as { url?: string }).url).toBeUndefined();
  });
});
