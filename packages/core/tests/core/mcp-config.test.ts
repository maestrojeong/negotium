import { describe, expect, test } from "bun:test";
import { registerCanonicalMcpBridgeEnvProvider } from "#mcp/canonical-bridge-config";
import {
  type HostedMcpContext,
  type HostedMcpSurface,
  resolveHostedMcpToken,
} from "#mcp/runtime-spec";
import { TSX_LOADER } from "#platform/config";
import {
  browserOwnerCapability,
  buildStdioMcpServer,
  consumePlaywrightUnavailable,
  getCronMcpServers,
  getDmMcpServers,
  getForumMcpServers,
  getManagerMcpServers,
  getMcpServersForQuery,
  markPlaywrightUnavailable,
  OPTIONAL_FORUM_MCP_SERVERS,
  registerRuntimeMcpServer,
  resolveCuaRsBinary,
  setCuaRsMcpPort,
} from "#platform/mcp-config";

/**
 * Playwright MCP transport selection.
 *
 * Claude and Maestro both use authenticated SSE, and Codex uses streamable
 * HTTP. All connect to the same long-lived Chromium/profile server with
 * owner-scoped tabs.
 *
 * Fallback (no port allocated): playwright is omitted. This avoids spawning
 * a per-turn Chromium child that dies with the agent process tree; the host
 * separately marks the turn as browser-unavailable and alerts the topic.
 */
describe("mcp-config: playwright transport selection per agent", () => {
  const userId = "9999";
  const playwrightPort = 39001;
  const playwrightCapability = "test-capability";
  const capabilityFor = (owner: string) => browserOwnerCapability(playwrightCapability, owner);
  const hostedContext = (spec: unknown, surface: HostedMcpSurface): HostedMcpContext => {
    const url = new URL((spec as { url: string }).url);
    expect(url.pathname).toContain(`/mcp/runtime/${surface}/`);
    const ctx = resolveHostedMcpToken(url.searchParams.get("token"), surface);
    expect(ctx).not.toBeNull();
    return ctx!;
  };

  test("codex stdio servers use the in-process tsx loader", () => {
    expect(buildStdioMcpServer("codex", "/tmp/server.ts", ["--flag"])).toEqual({
      command: "node",
      args: ["--import", TSX_LOADER, "/tmp/server.ts", "--flag"],
      env: { TSX_TSCONFIG_PATH: expect.any(String) },
    });
  });

  test("no-tool auxiliary calls receive no MCP servers", () => {
    expect(
      getMcpServersForQuery({
        agent: "codex",
        prompt: "summarize untrusted transcript",
        cwd: "/tmp/compact",
        systemPrompt: "return text only",
        userId,
        session: "compact",
        sessionType: "ephemeral",
        toolPolicy: "none",
      }),
    ).toEqual({});
  });

  test("compaction-log calls receive only the scoped reader MCP", () => {
    const compactLog = { command: "bun", args: ["run", "/tmp/compact-log-server.ts"] };
    expect(
      getMcpServersForQuery({
        agent: "claude",
        prompt: "summarize a long transcript",
        cwd: "/tmp/compact",
        systemPrompt: "read only the scoped compact log",
        userId,
        session: "compact",
        sessionType: "ephemeral",
        toolPolicy: "compaction-log",
        mcpExtra: {
          compact_log: compactLog,
          vault: { command: "forbidden" },
        },
      }),
    ).toEqual({ compact_log: compactLog });
  });

  test("forum/claude with port → owner-scoped SSE", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "claude",
      playwrightPort,
      playwrightCapability,
    });
    const query = new URLSearchParams({ owner: "user:9999:coding" });
    expect(servers.playwright).toEqual({
      type: "sse",
      url: `http://127.0.0.1:${playwrightPort}/sse?${query}`,
      headers: { "X-Browser-Capability": capabilityFor("user:9999:coding") },
    });
  });

  test("forum/maestro with port → owner-scoped SSE", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "maestro",
      playwrightPort,
      playwrightCapability,
    });
    const query = new URLSearchParams({ owner: "user:9999:coding" });
    expect(servers.playwright).toEqual({
      type: "sse",
      url: `http://127.0.0.1:${playwrightPort}/sse?${query}`,
      headers: { "X-Browser-Capability": capabilityFor("user:9999:coding") },
    });
  });

  test("forum/codex with port → streamable HTTP (/mcp) — same Chromium, same profile", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "codex",
      playwrightPort,
      playwrightCapability,
    });
    const query = new URLSearchParams({ owner: "user:9999:coding" });
    expect(servers.playwright).toEqual({
      url: `http://127.0.0.1:${playwrightPort}/mcp?${query}`,
      env_http_headers: { "X-Browser-Capability": "NEGOTIUM_BROWSER_CAPABILITY" },
    });
  });

  test("dm/codex with port → /mcp shape", () => {
    const servers = getDmMcpServers({
      userId,
      agent: "codex",
      playwrightPort,
      playwrightCapability,
    });
    const query = new URLSearchParams({ owner: "user:9999:dm" });
    expect(servers.playwright).toEqual({
      url: `http://127.0.0.1:${playwrightPort}/mcp?${query}`,
      env_http_headers: { "X-Browser-Capability": "NEGOTIUM_BROWSER_CAPABILITY" },
    });
  });

  test("dm/claude with port → owner-scoped SSE", () => {
    const servers = getDmMcpServers({
      userId,
      agent: "claude",
      playwrightPort,
      playwrightCapability,
    });
    const query = new URLSearchParams({ owner: "user:9999:dm" });
    expect(servers.playwright).toEqual({
      type: "sse",
      url: `http://127.0.0.1:${playwrightPort}/sse?${query}`,
      headers: { "X-Browser-Capability": capabilityFor("user:9999:dm") },
    });
  });

  test("Unicode owners are percent-encoded for every agent transport", () => {
    const owner = "user:9999:한국어 토픽";
    for (const agent of ["claude", "maestro", "codex"] as const) {
      const servers = getForumMcpServers({
        userId,
        session: "한국어 토픽",
        agent,
        playwrightPort,
        playwrightCapability,
      });
      const url = new URL((servers.playwright as { url: string }).url);
      expect(url.searchParams.get("owner")).toBe(owner);
      expect(url.searchParams.has("capability")).toBe(false);
      expect(
        () => new Headers((servers.playwright as { headers?: Record<string, string> }).headers),
      ).not.toThrow();
    }
  });

  test("a port without its capability does not expose browser tools", () => {
    const servers = getDmMcpServers({ userId, agent: "codex", playwrightPort });
    expect(servers.playwright).toBeUndefined();
  });

  test("Vault uses direct substitution except for Codex native shell/HTTP", () => {
    const vaultUserId = "topic-owner";
    const codex = getForumMcpServers({
      userId,
      vaultUserId,
      session: "coding",
      topicId: "vault-codex",
      agent: "codex",
      enabled: [],
    });
    const claude = getForumMcpServers({
      userId,
      vaultUserId,
      session: "coding",
      topicId: "vault-claude",
      agent: "claude",
      enabled: [],
    });
    expect((codex.vault as { url: string }).url).toContain("/mcp/runtime/vault/mcp?");
    expect(claude.vault).toEqual({
      type: "sse",
      url: expect.stringContaining("/mcp/runtime/vault/sse?"),
      timeout: 600000,
    });
    expect(hostedContext(codex.vault, "vault").agent).toBe("codex");
    expect(hostedContext(claude.vault, "vault").agent).toBe("claude");
    expect(hostedContext(codex.vault, "vault").userId).toBe(vaultUserId);
    expect(hostedContext(claude.vault, "vault").userId).toBe(vaultUserId);
  });

  test("manager/codex omits heavyweight browser tools even with a port", () => {
    const topicId = "private-general-topic";
    const servers = getManagerMcpServers({
      userId,
      topicId,
      agent: "codex",
      playwrightPort,
      playwrightCapability,
    });
    expect(servers.playwright).toBeUndefined();
    expect(servers.runtime).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/mcp\?token=.+/),
    });
    expect(hostedContext(servers["session-comm"], "session-comm").topicId).toBe(topicId);
    expect(hostedContext(servers.wiki, "wiki").wikiTopicId).toBe(topicId);
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
      topicId: "topic-coding-1",
      agent: "claude",
      bgBashPort: 9500,
    });
    expect(servers["background-bash"]).toEqual({
      type: "sse",
      url: "http://127.0.0.1:9500/sse",
      headers: {
        "X-Background-Bash-User": userId,
        // Routed by canonical topic id, never the session/title.
        "X-Background-Bash-Topic": "topic-coding-1",
        "X-Background-Bash-Capability": expect.any(String),
      },
    });
  });

  test("background-bash uses streamable HTTP for codex", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "topic-coding-1",
      agent: "codex",
      bgBashPort: 9500,
    });
    expect(servers["background-bash"]).toEqual({
      url: "http://127.0.0.1:9500/mcp",
      http_headers: {
        "X-Background-Bash-User": userId,
        "X-Background-Bash-Topic": "topic-coding-1",
        "X-Background-Bash-Capability": expect.any(String),
      },
    });
  });

  test("background-bash is omitted from forum defaults when no port is provided", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "topic-coding-1",
      agent: "claude",
    });
    expect(servers["background-bash"]).toBeUndefined();
  });

  test("background-bash is omitted without a topic id (completions can't be routed)", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      agent: "claude",
      bgBashPort: 9500,
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
    expect(hostedContext(servers.task, "task").topicId).toBe("runtime-codex");
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
    expect(hostedContext(servers["session-comm"], "session-comm").topicId).toBe("topic-abc-123");
  });

  test("session-comm receives the subagent parent id in forum scope", () => {
    const servers = getForumMcpServers({
      userId,
      session: "child",
      topicId: "child-topic",
      subagentParentTopicId: "parent-topic",
      agent: "claude",
    });
    expect(hostedContext(servers["session-comm"], "session-comm").subagentParentTopicId).toBe(
      "parent-topic",
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
      lifecycle: "turn",
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
      playwrightCapability,
    });
    const query = new URLSearchParams({ owner: "topic:cron-topic-id" });
    expect(servers.playwright).toEqual({
      url: `http://127.0.0.1:${playwrightPort}/mcp?${query}`,
      env_http_headers: { "X-Browser-Capability": "NEGOTIUM_BROWSER_CAPABILITY" },
    });
    expect(servers.runtime).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/mcp\?token=.+/),
    });
    expect(servers.wiki).toBeDefined();
    expect(hostedContext(servers.task, "task").topicId).toBe("cron-topic-id");
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
    expect(servers.runtime).toEqual({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/runtime\/mcp\?token=.+/),
    });
    expect(hostedContext(servers.wiki, "wiki").wikiTopicId).toBe("general");
    expect(hostedContext(servers.task, "task").topicId).toBe("general");
  });

  test("runtime-managed tools stay active outside the optional whitelist", () => {
    const servers = getForumMcpServers({
      userId,
      session: "coding",
      topicId: "topic-coding-1",
      agent: "codex",
      bgBashPort: 9500,
      enabled: ["wiki"],
    });
    expect(servers["background-bash"]).toBeDefined();
    expect(OPTIONAL_FORUM_MCP_SERVERS).not.toContain("background-bash");
    expect(OPTIONAL_FORUM_MCP_SERVERS).not.toContain("playwright");
  });

  test("wiki receives the REST topic id when one is available", () => {
    const servers = getForumMcpServers({
      userId,
      session: "Roadmap Notes",
      topicId: "topic-abc-123",
      agent: "codex",
      enabled: ["wiki"],
    });
    expect(hostedContext(servers.wiki, "wiki").wikiTopicId).toBe("topic-abc-123");
    expect(hostedContext(servers.skills, "skills").topicId).toBe("topic-abc-123");
  });

  test("placed turns proxy canonical task/wiki while vault and skills stay node-local", () => {
    const unregister = registerCanonicalMcpBridgeEnvProvider((scope) => ({
      env: {
        NEGOTIUM_CANONICAL_MCP_BRIDGE_URL: `http://127.0.0.1/${scope.surface}`,
        NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN: `token-${scope.surface}`,
      },
      revoke: () => undefined,
    }));
    try {
      const servers = getForumMcpServers({
        userId: "placed-user",
        session: "worker-mirror",
        topicId: "local-mirror-topic",
        queryId: "local-query",
        agent: "claude",
        enabled: [],
        peerBridge: {
          hubCellId: "hub-cell",
          hostTopicId: "hub-topic",
          hostQueryId: "hub-query",
          canSpawnSubagents: false,
        },
      });
      const task = servers.task as { args: string[]; env: Record<string, string> };
      const wiki = servers.wiki as { args: string[]; env: Record<string, string> };
      const skills = servers.skills;
      const vault = servers.vault;

      expect(task.args).toContain("--surface=task");
      expect(wiki.args).toContain("--surface=wiki");
      expect(task.env.NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN).toBe("token-task");
      expect(wiki.env.NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN).toBe("token-wiki");
      expect(hostedContext(skills, "skills").topicId).toBe("local-mirror-topic");
      expect(hostedContext(vault, "vault").peerBridge).toEqual({
        hubCellId: "hub-cell",
        hostTopicId: "hub-topic",
        hostQueryId: "hub-query",
        canSpawnSubagents: false,
      });
    } finally {
      unregister();
    }
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
    const wiki = hostedContext(servers.wiki, "wiki");
    expect(wiki.wikiTopicId).toBe("root-topic-456");
    expect(wiki.topicId).toBe("child-topic-123");
  });

  test("wiki falls back to session when no REST topic id is available", () => {
    const servers = getForumMcpServers({
      userId,
      session: "__archiver_deleted-topic",
      agent: "codex",
      enabled: ["wiki"],
    });
    expect(hostedContext(servers.wiki, "wiki").wikiTopicId).toBe("__archiver_deleted-topic");
  });

  test("built-in MCP transport can roll back to stdio", () => {
    const previous = process.env.NEGOTIUM_BUILTIN_MCP_TRANSPORT;
    process.env.NEGOTIUM_BUILTIN_MCP_TRANSPORT = "stdio";
    try {
      const servers = getForumMcpServers({
        userId,
        session: "rollback",
        topicId: "rollback-topic",
        agent: "codex",
      });
      expect(servers.task).toEqual({
        command: "node",
        args: [
          "--import",
          TSX_LOADER,
          expect.stringContaining("task-server.ts"),
          `--user-id=${userId}`,
          "--topic=rollback",
          "--topic-id=rollback-topic",
        ],
        env: { TSX_TSCONFIG_PATH: expect.any(String) },
      });
    } finally {
      if (previous === undefined) delete process.env.NEGOTIUM_BUILTIN_MCP_TRANSPORT;
      else process.env.NEGOTIUM_BUILTIN_MCP_TRANSPORT = previous;
    }
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

/**
 * cua-rs: the macOS desktop-control server.
 *
 * Two properties worth pinning. The entry disappears when the binary is not
 * installed, rather than advertising tools that cannot run — Linux hosts and
 * un-installed Macs are the normal case, not an error.
 */
describe("mcp-config: cua-rs", () => {
  const withEnv = <T>(env: Record<string, string | undefined>, run: () => T): T => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return run();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("is omitted outside macOS even when an executable override exists", () => {
    const binary = withEnv({ NEGOTIUM_CUA_RS_BIN: "/bin/echo" }, () => resolveCuaRsBinary("linux"));
    expect(binary).toBeNull();
  });

  test("an unusable override falls through to the installed binary", () => {
    // The override is the first candidate, not the only one: a stale
    // NEGOTIUM_CUA_RS_BIN left over from a deleted local build must not take
    // the server away from someone who has it installed normally.
    const binary = withEnv({ NEGOTIUM_CUA_RS_BIN: "/nonexistent/cua-rs" }, () =>
      resolveCuaRsBinary("darwin"),
    );
    expect(binary).not.toBe("/nonexistent/cua-rs");
  });

  test("uses the node-owned Streamable HTTP server and never a stdio command", () => {
    setCuaRsMcpPort(9350);
    try {
      const server = getForumMcpServers({
        userId: "u",
        session: "desktop",
        agent: "codex",
        enabled: ["cua-rs"],
      })["cua-rs"];
      expect(server).toEqual({ type: "http", url: "http://127.0.0.1:9350/mcp" });
    } finally {
      setCuaRsMcpPort(undefined);
    }
  });

  test("presents the bearer token cua-rs 0.8.0 requires on /mcp", () => {
    // Without the header the server answers 401 and every desktop tool
    // disappears, so the token travelling with the URL is the whole point.
    setCuaRsMcpPort(9350, "deadbeef");
    try {
      const forCodex = getForumMcpServers({
        userId: "u",
        session: "desktop",
        agent: "codex",
        enabled: ["cua-rs"],
      })["cua-rs"];
      expect(forCodex).toEqual({
        type: "http",
        url: "http://127.0.0.1:9350/mcp",
        http_headers: { Authorization: "Bearer deadbeef" },
      });

      const forClaude = getForumMcpServers({
        userId: "u",
        session: "desktop",
        agent: "claude",
        enabled: ["cua-rs"],
      })["cua-rs"];
      expect(forClaude).toEqual({
        type: "http",
        url: "http://127.0.0.1:9350/mcp",
        headers: { Authorization: "Bearer deadbeef" },
      });
    } finally {
      setCuaRsMcpPort(undefined);
    }
  });

  test("forgets the token when the port goes away", () => {
    setCuaRsMcpPort(9350, "deadbeef");
    setCuaRsMcpPort(undefined);
    setCuaRsMcpPort(9350);
    try {
      const server = getForumMcpServers({
        userId: "u",
        session: "desktop",
        agent: "claude",
        enabled: ["cua-rs"],
      })["cua-rs"];
      // An older cua-rs asks for no token; sending a stale one would be worse
      // than sending none.
      expect(server).toEqual({ type: "http", url: "http://127.0.0.1:9350/mcp" });
    } finally {
      setCuaRsMcpPort(undefined);
    }
  });
});
