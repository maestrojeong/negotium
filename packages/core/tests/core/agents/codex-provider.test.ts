import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "patch-1:1",
      content: "update applied: src/app.ts",
    });
  });

  test("keeps fallback baselines current after a native preview of the same file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "negotium-codex-diff-"));
    const path = join(cwd, "app.ts");
    const threadId = "019dee65-ffff-7aaa-8aaa-eeeeeeeeeeee";
    const rolloutDir = join(codexAuthDir, "sessions", "2026", "07", "22");
    const rolloutPath = join(rolloutDir, `rollout-test-${threadId}.jsonl`);
    execFileSync("git", ["init", "-q", cwd]);
    writeFileSync(path, "const kept = true;\nconst value = 'old';\n", "utf8");
    streamedEvents = async function* fileChangesWithContent() {
      yield { type: "thread.started", thread_id: threadId };
      writeFileSync(path, "const kept = true;\nconst value = 'new';\n", "utf8");
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(
        rolloutPath,
        `${JSON.stringify({
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            // Native rollout call IDs are independent from SDK item IDs.
            call_id: "native-call-1",
            changes: {
              [path]: {
                type: "update",
                unified_diff:
                  "@@ -1,2 +1,2 @@\n const kept = true;\n-const value = 'old';\n+const value = 'new';\n",
              },
            },
          },
        })}\n`,
        "utf8",
      );
      yield {
        type: "item.completed",
        item: {
          id: "patch-preview-1",
          type: "file_change",
          status: "completed",
          changes: [{ path: "app.ts", kind: "update" }],
        },
      };
      writeFileSync(
        path,
        "const kept = true;\nconst value = 'newer';\nconst extra = true;\n",
        "utf8",
      );
      yield {
        type: "item.completed",
        item: {
          id: "patch-preview-2",
          type: "file_change",
          status: "completed",
          changes: [{ path: "app.ts", kind: "update" }],
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    try {
      const events = [];
      for await (const event of codexProvider(opts({ sessionId: null, cwd }))) events.push(event);

      expect(events).toContainEqual({
        type: "tool_use",
        name: "Edit",
        toolUseId: "patch-preview-1:0",
        input: {
          file_path: "app.ts",
          change_kind: "update",
          before: "const value = 'old';",
          after: "const value = 'new';",
          diff_preview: "1  const kept = true;\n2 -const value = 'old';\n2 +const value = 'new';",
        },
      });
      expect(events).toContainEqual({
        type: "tool_use",
        name: "Edit",
        toolUseId: "patch-preview-2:0",
        input: {
          file_path: "app.ts",
          change_kind: "update",
          before: "const value = 'new';",
          after: "const value = 'newer';\nconst extra = true;",
          diff_preview:
            "2 -const value = 'new';\n2 +const value = 'newer';\n3 +const extra = true;",
        },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(rolloutPath, { force: true });
    }
  });

  test("canonicalizes symlinked file paths before filesystem fallback", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "negotium-codex-symlink-root-"));
    const linkParent = mkdtempSync(join(tmpdir(), "negotium-codex-symlink-link-"));
    const linkedCwd = join(linkParent, "workspace");
    const path = join(cwd, "app.ts");
    const linkedPath = join(linkedCwd, "app.ts");
    execFileSync("git", ["init", "-q", cwd]);
    writeFileSync(path, "const value = 'old';\n", "utf8");
    symlinkSync(cwd, linkedCwd, "dir");
    streamedEvents = async function* symlinkedFileChange() {
      yield { type: "thread.started", thread_id: "019dee65-ffff-7aaa-8aaa-eeeeeeeeeeea" };
      writeFileSync(path, "const value = 'new';\n", "utf8");
      yield {
        type: "item.completed",
        item: {
          id: "patch-symlink",
          type: "file_change",
          status: "completed",
          changes: [{ path: linkedPath, kind: "update" }],
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    try {
      const events = [];
      for await (const event of codexProvider(opts({ sessionId: null, cwd: linkedCwd }))) {
        events.push(event);
      }
      expect(events).toContainEqual({
        type: "tool_use",
        name: "Edit",
        toolUseId: "patch-symlink:0",
        input: {
          file_path: linkedPath,
          change_kind: "update",
          before: "const value = 'old';",
          after: "const value = 'new';",
          diff_preview: "1 -const value = 'old';\n1 +const value = 'new';",
        },
      });
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("bounds dirty baseline contents and omits unsafe overflow previews", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "negotium-codex-baseline-limit-"));
    execFileSync("git", ["init", "-q", cwd]);
    for (let index = 0; index <= 200; index += 1) {
      writeFileSync(join(cwd, `file-${String(index).padStart(3, "0")}.txt`), "old\n", "utf8");
    }
    const overflowPath = join(cwd, "file-200.txt");
    streamedEvents = async function* overflowFileChange() {
      yield { type: "thread.started", thread_id: "019dee65-ffff-7aaa-8aaa-eeeeeeeeeeeb" };
      writeFileSync(overflowPath, "new\n", "utf8");
      yield {
        type: "item.completed",
        item: {
          id: "patch-overflow",
          type: "file_change",
          status: "completed",
          changes: [{ path: overflowPath, kind: "update" }],
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    try {
      const events = [];
      for await (const event of codexProvider(opts({ sessionId: null, cwd }))) events.push(event);
      expect(events).toContainEqual({
        type: "tool_use",
        name: "Edit",
        toolUseId: "patch-overflow:0",
        input: { file_path: overflowPath, change_kind: "update" },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("waits for native +/- previews when rollout flushing trails file_change", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "negotium-codex-nongit-"));
    const path = join(cwd, "app.ts");
    const threadId = "019dee65-ffff-7aaa-8aaa-eeeeeeeeeeef";
    const rolloutDir = join(codexAuthDir, "sessions", "2026", "07", "22");
    const rolloutPath = join(rolloutDir, `rollout-test-${threadId}.jsonl`);
    writeFileSync(path, "const value = 'old';\n", "utf8");
    streamedEvents = async function* fileChangeWithNativeDiff() {
      yield { type: "thread.started", thread_id: threadId };
      writeFileSync(path, "const value = 'new';\n", "utf8");
      setTimeout(() => {
        mkdirSync(rolloutDir, { recursive: true });
        writeFileSync(
          rolloutPath,
          `${JSON.stringify({
            type: "event_msg",
            payload: {
              type: "patch_apply_end",
              // Native rollout call IDs are independent from SDK item IDs.
              call_id: "native-call-delayed",
              changes: {
                [path]: {
                  type: "update",
                  unified_diff: "@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n",
                },
              },
            },
          })}\n`,
          "utf8",
        );
      }, 120);
      yield {
        type: "item.completed",
        item: {
          id: "patch-preview-native",
          type: "file_change",
          status: "completed",
          changes: [{ path, kind: "update" }],
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    try {
      const events = [];
      for await (const event of codexProvider(opts({ sessionId: null, cwd }))) events.push(event);

      expect(events).toContainEqual({
        type: "tool_use",
        name: "Edit",
        toolUseId: "patch-preview-native:0",
        input: {
          file_path: path,
          change_kind: "update",
          before: "const value = 'old';",
          after: "const value = 'new';",
          diff_preview: "1 -const value = 'old';\n1 +const value = 'new';",
        },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(rolloutPath, { force: true });
    }
  });

  test("flags failed apply_patch changes with an explicit error result", async () => {
    streamedEvents = async function* failedFileChange() {
      yield { type: "thread.started", thread_id: "019dee65-ffff-7aaa-8aaa-dddddddddddd" };
      yield {
        type: "item.completed",
        item: {
          id: "patch-2",
          type: "file_change",
          status: "failed",
          changes: [{ path: "src/app.ts", kind: "update" }],
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    const events = [];
    for await (const event of codexProvider(opts({ sessionId: null }))) events.push(event);

    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "patch-2:0",
      content: "update failed: src/app.ts",
      isError: true,
    });
  });

  test("flags failed command and MCP results with explicit errors", async () => {
    streamedEvents = async function* failedTools() {
      yield { type: "thread.started", thread_id: "019dee65-ffff-7aaa-8aaa-eeeeeeeeeeed" };
      yield {
        type: "item.started",
        item: { id: "command-failed", type: "command_execution", command: "false" },
      };
      yield {
        type: "item.completed",
        item: {
          id: "command-failed",
          type: "command_execution",
          status: "failed",
          exit_code: 1,
          aggregated_output: "command failed",
        },
      };
      yield {
        type: "item.started",
        item: {
          id: "mcp-failed",
          type: "mcp_tool_call",
          tool: "example",
          arguments: {},
        },
      };
      yield {
        type: "item.completed",
        item: {
          id: "mcp-failed",
          type: "mcp_tool_call",
          status: "failed",
          error: { message: "tool failed" },
        },
      };
      yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } };
    };

    const events = [];
    for await (const event of codexProvider(opts({ sessionId: null }))) events.push(event);

    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "command-failed",
      content: "command failed",
      isError: true,
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "mcp-failed",
      content: "tool failed",
      isError: true,
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
