import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CODEX_VERSION } from "#agents/codex-native-multi-agent";
import type { AgentQueryOptions } from "#types";

// `codexProvider` does an up-front `existsSync(codexAuthPath)` check
// (codex-provider.ts:248) so a missing auth file returns an early error
// event instead of waiting for the SDK to surface an opaque OAuth
// failure. Override the path via the documented env var so this test
// runs on CI runners that boot without `~/.codex/auth.json`. The actual
// SDK is replaced by the `@openai/codex-sdk` mock below, so the auth
// file content is never read — only its presence matters.
const codexAuthDir = mkdtempSync(join(tmpdir(), "otium-codex-auth-"));
const codexAuthPath = join(codexAuthDir, "auth.json");
writeFileSync(codexAuthPath, "{}", "utf8");
writeFileSync(
  join(codexAuthDir, "models_cache.json"),
  JSON.stringify({
    client_version: BUNDLED_CODEX_VERSION,
    models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v1" }],
  }),
  "utf8",
);
process.env.NEGOTIUM_CODEX_AUTH_FILE = codexAuthPath;
process.env.CODEX_HOME = codexAuthDir;
const codexModelCatalogPath = join(
  codexAuthDir,
  `negotium-model-catalog-${BUNDLED_CODEX_VERSION}.json`,
);

const resumeRunStreamed = mock(async (_prompt: string, _opts?: Record<string, unknown>) => {
  throw new Error("thread/resume failed: no rollout found");
});

async function* fallbackEvents() {
  yield { type: "thread.started", thread_id: "019dee65-ffff-7aaa-8aaa-aaaaaaaaaaaa" };
  yield {
    type: "item.completed",
    item: { type: "agent_message", text: "fresh answer" },
  };
  yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
}

const startRunStreamed = mock(async (_prompt: string, _opts?: Record<string, unknown>) => ({
  events: streamedEvents(),
}));
const resumeThread = mock(() => ({ runStreamed: resumeRunStreamed }));
const startThread = mock(() => ({ runStreamed: startRunStreamed }));
const codexConstructor = mock((_options?: Record<string, unknown>) => {});
let streamedEvents: () => AsyncGenerator<Record<string, unknown>> = fallbackEvents;

mock.module("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options?: Record<string, unknown>) {
      codexConstructor(options);
    }
    resumeThread = resumeThread;
    startThread = startThread;
  },
}));

mock.module("#platform/mcp-config", () => ({
  browserOwnerCapability: (capability: string, owner: string) => `${capability}:${owner}`,
  browserOwnerForContext: (context: { userId?: string; session?: string; topicId?: string }) =>
    context.topicId
      ? `topic:${context.topicId}`
      : context.userId && context.session
        ? `user:${context.userId}:${context.session}`
        : undefined,
  CODEX_BROWSER_CAPABILITY_ENV: "NEGOTIUM_BROWSER_CAPABILITY",
  getMcpServersForQuery: () => ({}),
}));

const { codexProvider, toCodexMcpServers } = await import("#agents/codex-provider");
const { configureAgentExecutionHost } = await import("#agents/execution-host");
let restoreExecutionHost: (() => void) | undefined;

function opts(overrides: Partial<AgentQueryOptions> = {}): AgentQueryOptions {
  return {
    agent: "codex",
    prompt: "hello",
    session: "dev",
    sessionId: "3f471a7f-2995-40d7-9aaa-aaaaaaaaaaaa",
    systemPrompt: "system",
    cwd: "/tmp",
    userId: "1",
    ...overrides,
  };
}

describe("codexProvider stale rollout recovery", () => {
  beforeEach(() => {
    restoreExecutionHost = configureAgentExecutionHost({
      getMcpServersForQuery: () => ({}),
    });
    streamedEvents = fallbackEvents;
    resumeRunStreamed.mockClear();
    startRunStreamed.mockClear();
    resumeThread.mockClear();
    startThread.mockClear();
    codexConstructor.mockClear();
  });

  afterEach(() => {
    restoreExecutionHost?.();
    restoreExecutionHost = undefined;
  });

  test("falls back to a fresh thread when resume cannot find a rollout", async () => {
    const events = [];
    for await (const event of codexProvider(opts())) events.push(event);

    expect(resumeThread).toHaveBeenCalledWith(
      "3f471a7f-2995-40d7-9aaa-aaaaaaaaaaaa",
      expect.any(Object),
    );
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(codexConstructor).toHaveBeenCalledWith({
      config: {
        features: { multi_agent: false, multi_agent_v2: false, enable_fanout: false },
        model_catalog_json: codexModelCatalogPath,
        mcp_servers: {
          playwright: expect.objectContaining({ enabled: false }),
          "browser-rs": expect.objectContaining({ enabled: false }),
          patchright: expect.objectContaining({ enabled: false }),
        },
      },
    });
    const catalog = JSON.parse(readFileSync(codexModelCatalogPath, "utf8"));
    expect(catalog.models[0].multi_agent_version).toBe("disabled");
    expect(resumeRunStreamed.mock.calls[0]?.[0]).toBe("[System Instructions]\nsystem\n\nhello");
    expect(startRunStreamed.mock.calls[0]?.[0]).toBe("[System Instructions]\nsystem\n\nhello");
    expect(events).toContainEqual({
      type: "session",
      sessionId: "019dee65-ffff-7aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(events).toContainEqual({ type: "text", content: "fresh answer" });
  });

  test("surfaces native apply_patch changes as Write/Edit/Delete tool events", async () => {
    streamedEvents = async function* fileChanges() {
      yield { type: "thread.started", thread_id: "019dee65-ffff-7aaa-8aaa-bbbbbbbbbbbb" };
      yield {
        type: "item.completed",
        item: {
          id: "patch-1",
          type: "file_change",
          status: "completed",
          changes: [
            { path: "src/new.ts", kind: "add" },
            { path: "src/app.ts", kind: "update" },
            { path: "src/old.ts", kind: "delete" },
          ],
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    const events = [];
    for await (const event of codexProvider(opts({ sessionId: null }))) events.push(event);

    expect(events).toContainEqual({
      type: "tool_use",
      name: "Write",
      input: { file_path: "src/new.ts", change_kind: "add" },
      toolUseId: "patch-1:0",
    });
    expect(events).toContainEqual({
      type: "tool_use",
      name: "Edit",
      input: { file_path: "src/app.ts", change_kind: "update" },
      toolUseId: "patch-1:1",
    });
    expect(events).toContainEqual({
      type: "tool_use",
      name: "Delete",
      input: { file_path: "src/old.ts", change_kind: "delete" },
      toolUseId: "patch-1:2",
    });
  });

  test("streams each agent message from its own item boundary", async () => {
    streamedEvents = async function* multipleMessages() {
      yield { type: "thread.started", thread_id: "019dee65-ffff-7aaa-8aaa-cccccccccccc" };
      yield {
        type: "item.updated",
        item: { id: "message-1", type: "agent_message", text: "first status" },
      };
      yield {
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "first status" },
      };
      yield {
        type: "item.started",
        item: { id: "tool-1", type: "command_execution", command: "pwd" },
      };
      yield {
        type: "item.completed",
        item: { id: "tool-1", type: "command_execution", aggregated_output: "/tmp" },
      };
      yield {
        type: "item.updated",
        item: { id: "message-2", type: "agent_message", text: "second status" },
      };
      yield {
        type: "item.completed",
        item: { id: "message-2", type: "agent_message", text: "second status" },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    const events = [];
    for await (const event of codexProvider(opts({ sessionId: null }))) events.push(event);

    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.content),
    ).toEqual(["first status", "second status"]);
  });
});

describe("codexProvider MCP config", () => {
  test("passes the browser capability only through the Codex child environment", async () => {
    const events = [];
    for await (const event of codexProvider(
      opts({ sessionId: null, playwrightCapability: "secret-capability" }),
    )) {
      events.push(event);
    }

    expect(codexConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          NEGOTIUM_BROWSER_CAPABILITY: "secret-capability:user:1:dev",
        }),
      }),
    );
  });

  test("renames playwright to avoid merging with a global Codex stdio server", () => {
    const servers = toCodexMcpServers({
      playwright: { url: "http://127.0.0.1:39001/mcp" },
      runtime: { url: "http://127.0.0.1:39002/mcp" },
      wiki: { command: "node", args: ["wiki-server.js"], env: { A: "B" } },
      sseOnly: { type: "sse", url: "http://127.0.0.1:39003/sse" },
    });

    expect(servers.playwright).toMatchObject({ enabled: false });
    expect(servers["browser-rs"]).toMatchObject({ enabled: false });
    expect(servers.patchright).toMatchObject({ enabled: false });
    expect(servers.otium_playwright).toMatchObject({
      url: "http://127.0.0.1:39001/mcp",
    });
    expect(servers.runtime).toMatchObject({
      url: "http://127.0.0.1:39002/mcp",
    });
    expect(servers.wiki).toMatchObject({
      command: "node",
      args: ["wiki-server.js"],
      env: { A: "B" },
    });
    expect(servers.sseOnly).toBeUndefined();
  });

  test("preserves header configuration for streamable HTTP servers", () => {
    const servers = toCodexMcpServers({
      playwright: {
        url: "http://127.0.0.1:39001/mcp",
        http_headers: { "X-Browser-Owner": "topic:one" },
        env_http_headers: { "X-Browser-Capability": "NEGOTIUM_BROWSER_CAPABILITY" },
      },
    });

    expect(servers.otium_playwright).toMatchObject({
      url: "http://127.0.0.1:39001/mcp",
      http_headers: { "X-Browser-Owner": "topic:one" },
      env_http_headers: { "X-Browser-Capability": "NEGOTIUM_BROWSER_CAPABILITY" },
    });
  });
});
