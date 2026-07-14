import { describe, expect, test } from "bun:test";
import {
  consumePlaywrightUnavailable,
  getCronMcpServers,
  getDmMcpServers,
  getForumMcpServers,
  getManagerMcpServers,
  markPlaywrightUnavailable,
  OPTIONAL_FORUM_MCP_SERVERS,
  registerRuntimeMcpServer,
} from "#platform/mcp-config";

/**
 * Playwright MCP transport selection.
 *
 * `@playwright/mcp` HTTP mode exposes two endpoints on the same port:
 *   - `/sse` — SSE transport (claude-agent-sdk, maestro)
 *   - `/mcp` — streamable HTTP (codex)
 *
 * Both endpoints front the same Chromium / userDataDir, so all three
 * agents share login state and cookies when targeting the same port.
 * The catalog `playwright.build()` picks the URL suffix per agent.
 *
 * Fallback (no port allocated): playwright is omitted. This avoids spawning
 * a per-turn Chromium child that dies with the agent process tree; the host
 * separately marks the turn as browser-unavailable and alerts the topic.
 */
describe("mcp-config: playwright transport selection per agent", () => {
  const userId = "9999";
  const playwrightPort = 39001;

  test("forum/claude with port → SSE (/sse) — shared profile", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "claude",
      playwrightPort,
    });
    expect(servers.playwright).toEqual({
      type: "sse",
      url: `http://127.0.0.1:${playwrightPort}/sse`,
    });
  });

  test("forum/maestro with port → SSE (/sse) — shared profile", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "maestro",
      playwrightPort,
    });
    expect(servers.playwright).toEqual({
      type: "sse",
      url: `http://127.0.0.1:${playwrightPort}/sse`,
    });
  });

  test("forum/codex with port → streamable HTTP (/mcp) — same Chromium, same profile", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "codex",
      playwrightPort,
    });
    expect(servers.playwright).toEqual({
      url: `http://127.0.0.1:${playwrightPort}/mcp`,
    });
  });

  test("dm/codex with port → /mcp shape", () => {
    const servers = getDmMcpServers({ userId, agent: "codex", playwrightPort });
    expect(servers.playwright).toEqual({
      url: `http://127.0.0.1:${playwrightPort}/mcp`,
    });
  });

  test("dm/claude with port → /sse shape", () => {
    const servers = getDmMcpServers({ userId, agent: "claude", playwrightPort });
    expect(servers.playwright).toEqual({
      type: "sse",
      url: `http://127.0.0.1:${playwrightPort}/sse`,
    });
  });

  test("Vault is always available and Codex gets the broker-only surface", () => {
    const codex = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "vault-codex",
      agent: "codex",
      enabled: [],
    });
    const claude = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "vault-claude",
      agent: "claude",
      enabled: [],
    });
    expect((codex.vault as { args: string[] }).args).toContain("--http-only=true");
    expect((claude.vault as { args: string[] }).args).not.toContain("--http-only=true");
  });

  test("manager/codex omits heavyweight browser/OCR tools even with a port", () => {
    const topicId = "private-general-topic";
    const servers = getManagerMcpServers({
      userId,
      topicId,
      agent: "codex",
      playwrightPort,
    });
    expect(servers.playwright).toBeUndefined();
    expect(servers.paddleocr).toBeUndefined();
    expect(servers.runtime).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/mcp\?token=.+/),
    });
    expect((servers["session-comm"] as { args: string[] }).args).toContain(`--topic-id=${topicId}`);
    expect((servers.wiki as { args: string[] }).args).toContain(`--topic-id=${topicId}`);
  });

  test("no port + claude → playwright omitted (no stdio child)", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "claude",
    });
    expect(servers.playwright).toBeUndefined();
  });

  test("no port + codex → playwright omitted (no stdio child)", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "codex",
    });
    expect(servers.playwright).toBeUndefined();
  });

  test("background-bash is included in forum defaults when a port is available", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "claude",
      bgBashPort: 9500,
    });
    expect(servers["background-bash"]).toEqual({
      type: "sse",
      url: "http://127.0.0.1:9500/sse",
    });
  });

  test("background-bash uses streamable HTTP for codex", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "codex",
      bgBashPort: 9500,
    });
    expect(servers["background-bash"]).toEqual({
      url: "http://127.0.0.1:9500/mcp",
    });
  });

  test("background-bash is omitted from forum defaults when no port is provided", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "claude",
    });
    expect(servers["background-bash"]).toBeUndefined();
  });

  test("runtime uses streamable HTTP for codex and survives restrictive whitelist", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "runtime-codex",
      agent: "codex",
      enabled: ["wiki"],
    });
    expect(servers.runtime).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/mcp\?token=.+/),
    });
    expect((servers.task as { args: string[] }).args).toContain("--topic-id=runtime-codex");
    expect(servers.visuals).toBeUndefined();
    expect(servers["send-file"]).toBeUndefined();
    expect(servers["topic-config"]).toBeUndefined();
  });

  test("session-comm receives the REST topic id in forum scope", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "topic-abc-123",
      agent: "claude",
    });
    expect((servers["session-comm"] as { args: string[] }).args).toContain(
      "--topic-id=topic-abc-123",
    );
  });

  test("runtime uses SSE for maestro", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "runtime-maestro",
      agent: "maestro",
      enabled: ["wiki"],
    });
    expect(servers.runtime).toEqual({
      type: "sse",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/sse\?token=.+/),
      timeout: 600000,
    });
  });

  test("runtime uses SSE for claude", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "runtime-claude",
      agent: "claude",
      enabled: ["wiki"],
    });
    expect(servers.runtime).toEqual({
      type: "sse",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/sse\?token=.+/),
      timeout: 600000,
    });
  });

  test("runtime is omitted without a topic id", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "claude",
    });
    expect(servers.runtime).toBeUndefined();
  });

  test("cron scope gets disposable browser/runtime tools without session-control tools", () => {
    const servers = getCronMcpServers({
      userId,
      session: "cron-topic",
      topicId: "cron-topic-id",
      agent: "codex",
      playwrightPort,
    });
    expect(servers.playwright).toEqual({
      url: `http://127.0.0.1:${playwrightPort}/mcp`,
    });
    expect(servers.runtime).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/mcp\?token=.+/),
    });
    expect(servers.wiki).toBeDefined();
    expect((servers.task as { args: string[] }).args).toContain("--topic-id=cron-topic-id");
    expect(servers["session-comm"]).toBeUndefined();
    expect(servers["cron-manager"]).toBeUndefined();
    expect(servers["background-bash"]).toBeUndefined();
  });

  test("manager scope uses the General REST topic context", () => {
    const servers = getManagerMcpServers({
      userId,
      agent: "codex",
      session: "General",
      topicId: "general",
      queryId: "manager-query",
      cwd: "/tmp/otium-general",
      model: "deepseek-pro",
    });
    expect(servers.playwright).toBeUndefined();
    expect(servers.paddleocr).toBeUndefined();
    expect(servers.runtime).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/mcp\?token=.+/),
    });
    expect((servers.wiki as { args: string[] }).args).toContain("--topic-id=general");
    expect((servers.task as { args: string[] }).args).toContain("--topic-id=general");
  });

  test("background-bash is excluded when not in whitelist", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "codex",
      bgBashPort: 9500,
      enabled: ["wiki"],
    });
    expect(servers["background-bash"]).toBeUndefined();
  });

  test("wiki receives the REST topic id when one is available", () => {
    const servers = getForumMcpServers({
      userId,
      session: "Roadmap Notes",
      topicId: "topic-abc-123",
      agent: "codex",
      enabled: ["wiki"],
    });
    const wiki = servers.wiki as { args: string[] };
    expect(wiki.args).toContain("--topic-id=topic-abc-123");
    expect(wiki.args).not.toContain("--topic-id=Roadmap Notes");
  });

  test("wiki receives the memory-origin topic id when one is provided", () => {
    const servers = getForumMcpServers({
      userId,
      session: "Forked Roadmap",
      topicId: "child-topic-123",
      wikiTopicId: "root-topic-456",
      agent: "codex",
      enabled: ["wiki"],
    });
    const wiki = servers.wiki as { args: string[] };
    expect(wiki.args).toContain("--topic-id=root-topic-456");
    expect(wiki.args).not.toContain("--topic-id=child-topic-123");
  });

  test("wiki falls back to session when no REST topic id is available", () => {
    const servers = getForumMcpServers({
      userId,
      session: "__archiver_deleted-topic",
      agent: "codex",
      enabled: ["wiki"],
    });
    const wiki = servers.wiki as { args: string[] };
    expect(wiki.args).toContain("--topic-id=__archiver_deleted-topic");
  });

  test("playwright unavailable marker is consumable exactly once", () => {
    markPlaywrightUnavailable({
      userId,
      topic: "coding",
      agent: "claude",
    });

    expect(consumePlaywrightUnavailable(userId, "coding")).toBe(true);
    expect(consumePlaywrightUnavailable(userId, "coding")).toBe(false);
  });

  test("optional modules can mount and unmount an MCP capability at node startup", () => {
    const unregister = registerRuntimeMcpServer("test-cron-manager", {
      scopes: ["forum", "manager"],
      forumRequired: true,
      build: ({ userId }) => ({ command: "test-cron", args: [userId] }),
    });

    try {
      const servers = getForumMcpServers({
        userId,
        session: "coding",
        agent: "codex",
        enabled: [],
      });
      expect(servers["test-cron-manager"]).toEqual({ command: "test-cron", args: [userId] });
      expect(OPTIONAL_FORUM_MCP_SERVERS).not.toContain("test-cron-manager");
    } finally {
      unregister();
    }

    expect(
      getForumMcpServers({ userId, session: "coding", agent: "codex", enabled: [] })[
        "test-cron-manager"
      ],
    ).toBeUndefined();
  });
});
