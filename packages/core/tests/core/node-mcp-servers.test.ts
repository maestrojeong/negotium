import { afterEach, describe, expect, test } from "bun:test";
import {
  ALL_FORUM_MCP_SERVER_NAMES,
  formatMcpStatus,
  getForumMcpServers,
  OPTIONAL_FORUM_MCP_SERVERS,
  prepareNodeMcpServersForQuery,
  setNodeMcpServers,
} from "#platform/mcp-config";

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
    expect(ALL_FORUM_MCP_SERVER_NAMES).toContain("browser2");
    expect(OPTIONAL_FORUM_MCP_SERVERS).toContain("browser2");

    const enabled = getForumMcpServers({
      userId: "u",
      session: "t",
      agent: "claude",
      enabled: ["browser2"],
    });
    expect(enabled.browser2).toEqual({ type: "sse", url: "http://127.0.0.1:9155/sse" });

    const disabled = getForumMcpServers({
      userId: "u",
      session: "t",
      agent: "claude",
      enabled: [],
    });
    expect(disabled.browser2).toBeUndefined();

    setNodeMcpServers([]);
    expect(ALL_FORUM_MCP_SERVER_NAMES).not.toContain("browser2");
    expect(OPTIONAL_FORUM_MCP_SERVERS).not.toContain("browser2");
  });

  test("entries shadowing built-in catalog keys are ignored", () => {
    setNodeMcpServers([{ key: "wiki", kind: "http", port: 9155 }]);
    const servers = getForumMcpServers({ userId: "u", session: "t", agent: "claude" });
    // The authenticated built-in wiki surface must win over the impostor.
    expect((servers.wiki as { url: string }).url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/wiki\/sse\?token=/,
    );
    expect((servers.wiki as { url: string }).url).not.toContain(":9155/");
    expect(ALL_FORUM_MCP_SERVER_NAMES.filter((name) => name === "wiki")).toHaveLength(1);
    expect(OPTIONAL_FORUM_MCP_SERVERS).not.toContain("wiki");
  });

  test("status omits configured node MCPs that are no longer available", () => {
    setNodeMcpServers([{ key: "browser2", kind: "http", port: 9155 }]);
    expect(formatMcpStatus({ enabled: ["browser2"] }).join("\n")).toContain("browser2");

    setNodeMcpServers([]);
    const status = formatMcpStatus({ enabled: ["browser2"] }).join("\n");
    expect(status).not.toContain("browser2");
    expect(status).toContain("선택 서버 (whitelist, 0개): 없음");
  });

  test("instance-scoped HTTP entries are prepared lazily per topic", async () => {
    const ensured: string[] = [];
    setNodeMcpServers([
      {
        key: "browser2",
        kind: "http-instance",
        async ensurePort(instanceKey) {
          ensured.push(instanceKey);
          return instanceKey === "topic-a" ? 9155 : 9156;
        },
      },
    ]);

    const query = (topicId: string, mcpEnabled: string[]) => ({
      agent: "codex" as const,
      prompt: "test",
      cwd: "/tmp",
      systemPrompt: "test",
      userId: "u",
      session: topicId,
      sessionType: "forum" as const,
      topicId,
      mcpEnabled,
    });

    await prepareNodeMcpServersForQuery(query("topic-a", ["browser2"]));
    expect(
      getForumMcpServers({
        userId: "u",
        session: "topic-a",
        topicId: "topic-a",
        agent: "codex",
        enabled: ["browser2"],
      }).browser2,
    ).toEqual({ url: "http://127.0.0.1:9155/mcp" });

    await prepareNodeMcpServersForQuery(query("topic-b", ["browser2"]));
    expect(
      getForumMcpServers({
        userId: "u",
        session: "topic-b",
        topicId: "topic-b",
        agent: "claude",
        enabled: ["browser2"],
      }).browser2,
    ).toEqual({ type: "sse", url: "http://127.0.0.1:9156/sse" });

    await prepareNodeMcpServersForQuery(query("topic-c", []));
    expect(ensured).toEqual(["topic-a", "topic-b"]);
  });
});
