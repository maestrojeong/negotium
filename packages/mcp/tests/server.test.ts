import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  claimDeliveryAck,
  ensurePersonalGeneral,
  getTopic,
  getTopicByNameForUser,
  getTopicSessionId,
  issueRuntimeMcpToken,
  NODE_LOCAL_USER_ID,
  type RuntimeMcpContext,
  registerPeerRuntimeBridge,
  registerTopic,
  resolveDeliveryAck,
  runtimeBus,
  sessionInboxPath,
  setFileHooks,
  setTopicSessionId,
  upsertTopic,
} from "@negotium/core";
import { handleNegotiumMcpRequest } from "../src/index";

/** The node's snippet backend, read the way `SNIPPETS_API_URL` reads it. Taken
 *  from the environment rather than from the tool factory on purpose: comparing
 *  registration against the factory's own output is what let these tools stay
 *  missing in production while the test agreed with the bug. */
const NODE_SNIPPET_BACKEND = (
  process.env.NEGOTIUM_SNIPPETS_API_URL ??
  process.env.SNIPPETS_API_URL ??
  ""
).trim();

const USER_ID = "test-user";

let server: ReturnType<typeof Bun.serve>;
let client: Client;
let ctx: RuntimeMcpContext;
let mainTopic: ReturnType<typeof registerTopic>;

function resultText(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  return content.map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  // The local (non-peer) send_file path stores the file as a host upload
  // before broadcasting it; the test host has no real uploads subsystem, so
  // stand in with a minimal one (mirrors otium's implementation shape).
  setFileHooks({
    resolveAttachmentByFileId: () => null,
    resolveUploadedFilePathByFileId: () => null,
    storeLocalFileAsUpload: (absPath) => ({
      id: randomUUID(),
      type: "file",
      filename: absPath.split("/").pop() ?? "file",
      url: `/files/${randomUUID()}`,
      mimeType: "application/octet-stream",
      sizeBytes: 0,
    }),
  });
  mainTopic = registerTopic({ title: "main-room", userId: USER_ID, agent: "claude" });
  ctx = {
    userId: USER_ID,
    topicId: mainTopic.id,
    topicTitle: mainTopic.title,
    cwd: mkdtempSync(join(tmpdir(), "negotium-mcp-cwd-")),
    agent: "claude",
    fileDeliveryTools: true,
  };

  server = Bun.serve({
    port: 0,
    fetch: async (req) =>
      (await handleNegotiumMcpRequest(req)) ?? new Response("host route", { status: 404 }),
  });

  const token = issueRuntimeMcpToken(ctx);
  const url = new URL(
    `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
  );
  client = new Client({ name: "negotium-mcp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
});

afterAll(async () => {
  await client?.close();
  server?.stop(true);
});

describe("negotium MCP endpoint", () => {
  test("ignores non-MCP paths so the host can fall through", async () => {
    const res = await handleNegotiumMcpRequest(new Request("http://127.0.0.1/api/topics"));
    expect(res).toBeNull();
  });

  test("rejects unsigned tokens", async () => {
    const res = await handleNegotiumMcpRequest(
      new Request("http://127.0.0.1/mcp/runtime/mcp?token=forged", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
      }),
    );
    expect(res?.status).toBe(401);
  });

  test("exposes node tools and shared runtime tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "register_topic",
      "list_topics",
      "abort_topic",
      "restart_topic",
      "delete_topic",
      "ask_user_question",
      "spawn_subagent",
      "list_memory_topics",
      "list_subagents",
      "delete_subagent",
      "send_file",
      "send_files",
      "set_model",
      "set_agent",
      "schedule_self",
      "get_self_schedule",
      "update_self_schedule",
      "cancel_self_schedule",
    ]) {
      expect(names).toContain(expected);
    }
    for (const visual of ["show_html", "show_mermaid", "show_image", "show_png", "show_video"]) {
      expect(names).not.toContain(visual);
    }
    expect(names).not.toContain("send_message");
  });

  test("authorizes subagent creation with the node principal while preserving an external actor", async () => {
    const suffix = randomUUID();
    const ownerId = `mapped-owner-${suffix}`;
    const actorUserId = `otium-hosted-${suffix}`;
    const parent = registerTopic({
      title: `mapped-parent-${suffix}`,
      userId: ownerId,
      agent: "claude",
      surface: "otium",
    });
    const mappedCtx: RuntimeMcpContext = {
      ...ctx,
      userId: ownerId,
      actorUserId,
      topicId: parent.id,
      topicTitle: parent.title,
    };
    const mappedClient = new Client({ name: "mapped-subagent-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken(mappedCtx);
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await mappedClient.connect(new StreamableHTTPClientTransport(url));
      const result = await mappedClient.callTool({
        name: "create_subagent",
        arguments: { task: "verify mapped-room authorization", name: `mapped-child-${suffix}` },
      });
      expect(result.isError).not.toBe(true);
      expect(resultText(result)).toContain("Subagent prepared");
    } finally {
      await mappedClient.close();
    }
  });

  test("keeps provider identity and node-native configuration tools off Otium topics", async () => {
    const suffix = randomUUID();
    const topic = registerTopic({
      title: `private-otium-${suffix}`,
      userId: USER_ID,
      agent: "claude",
      surface: "otium",
    });
    const privateClient = new Client({ name: "otium-private-runtime-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      topicId: topic.id,
      topicTitle: topic.title,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await privateClient.connect(new StreamableHTTPClientTransport(url));
      const tools = (await privateClient.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      for (const hidden of [
        "get_model",
        "set_model",
        "get_agent",
        "set_agent",
        "get_effort",
        "set_effort",
        "register_topic",
      ]) {
        expect(names).not.toContain(hidden);
      }
      for (const toolName of ["spawn_subagent", "create_subagent"]) {
        const tool = tools.find((candidate) => candidate.name === toolName);
        const properties = (tool?.inputSchema as { properties?: Record<string, unknown> })
          ?.properties;
        expect(properties).toBeDefined();
        expect(properties).not.toHaveProperty("agent");
        expect(properties).not.toHaveProperty("model");
      }
      expect(names).toContain("list_topics");
      const listed = await privateClient.callTool({ name: "list_topics", arguments: {} });
      expect(resultText(listed)).not.toContain("agent:");
      expect(resultText(listed)).not.toContain("claude");
    } finally {
      await privateClient.close();
    }
  });

  test("exposes visual tools only when the adapter grants the capability", async () => {
    const visualClient = new Client({ name: "negotium-visual-mcp-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      visualTools: true,
      fileDeliveryTools: false,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await visualClient.connect(new StreamableHTTPClientTransport(url));
      const names = (await visualClient.listTools()).tools.map((tool) => tool.name);
      // `show_png` is the pre-rename alias of `show_image`; it rides the same
      // capability, so a session that still calls it by the old name works.
      for (const visual of ["show_html", "show_mermaid", "show_image", "show_png"]) {
        expect(names).toContain(visual);
      }
      // Removed as a capability, not merely ungranted: a room that gets every
      // visual tool still must not get this one back.
      expect(names).not.toContain("show_video");
      expect(names).not.toContain("send_file");
      expect(names).not.toContain("send_files");
      // publish_html is gated by the capability *and* by this node's own snippet
      // backend, which the gateway cannot supply. Pinned against the config
      // value rather than against the factory's output, so it fails either way
      // round: a publish tool offered with no backend to mint links, or one
      // missing on a node that has a backend configured.
      for (const publishTool of ["publish_html", "unpublish_html"]) {
        expect(names.includes(publishTool)).toBe(Boolean(NODE_SNIPPET_BACKEND));
      }
    } finally {
      await visualClient.close();
    }
  });

  test("keeps host MCP credentials out of config-change auto-continue entries", async () => {
    const autoClient = new Client({ name: "negotium-auto-continue-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      autoContinue: true,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await autoClient.connect(new StreamableHTTPClientTransport(url));
      const result = await autoClient.callTool({
        name: "set_effort",
        arguments: { effort: "high" },
      });
      expect(result.isError).toBeFalsy();
      const entries = readFileSync(sessionInboxPath(USER_ID, mainTopic.id), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries.at(-1)).toMatchObject({
        type: "tell",
        from: "auto-continue",
      });
      expect(entries.at(-1)).not.toHaveProperty("hostMcpServers");
    } finally {
      await autoClient.close();
    }
  });

  test("does not expose ask_user_question in a subagent room", async () => {
    const child = registerTopic({
      title: `ask-disabled-subagent-${randomUUID()}`,
      userId: USER_ID,
      agent: "codex",
    });
    child.parentTopicId = mainTopic.id;
    child.isSubagent = true;
    upsertTopic(child);

    const childClient = new Client({ name: "negotium-subagent-mcp-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      topicId: child.id,
      topicTitle: child.title,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await childClient.connect(new StreamableHTTPClientTransport(url));
      const names = (await childClient.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("ask_user_question");
    } finally {
      await childClient.close();
    }
  });

  test("omits visual and file tools when no adapter grants either capability", async () => {
    const headlessClient = new Client({ name: "negotium-headless-mcp-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      visualTools: false,
      fileDeliveryTools: false,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await headlessClient.connect(new StreamableHTTPClientTransport(url));
      const names = (await headlessClient.listTools()).tools.map((tool) => tool.name);
      for (const name of [
        "show_html",
        "show_mermaid",
        "show_image",
        "show_png",
        "show_video",
        "send_file",
        "send_files",
      ]) {
        expect(names).not.toContain(name);
      }
    } finally {
      await headlessClient.close();
    }
  });

  test("send_file uses the canonical hub bridge during a peer turn", async () => {
    const filePath = join(ctx.cwd, "peer-output.txt");
    writeFileSync(filePath, "peer output");
    const calls: Array<{ path: string; source: string }> = [];
    const unregister = registerPeerRuntimeBridge({
      async spawnSubagent() {
        return { content: [{ type: "text", text: "unused" }] };
      },
      async sendFile(request) {
        calls.push({ path: request.path, source: request.source });
        return { ok: true };
      },
      async showVisual() {
        return { ok: false, error: "hub unavailable" };
      },
    });
    const peerCtx: RuntimeMcpContext = {
      ...ctx,
      visualTools: true,
      peerBridge: {
        hubCellId: "hub-cell",
        hostTopicId: "host-topic",
        hostQueryId: "host-query",
        canSpawnSubagents: true,
      },
    };
    const peerClient = new Client({ name: "negotium-peer-mcp-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken(peerCtx);
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await peerClient.connect(new StreamableHTTPClientTransport(url));
      const result = await peerClient.callTool({
        name: "send_file",
        arguments: { file_path: filePath },
      });
      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([{ path: filePath, source: "runtime.send_file" }]);
      const visualResult = await peerClient.callTool({
        name: "show_html",
        arguments: { html: "<p>not delivered</p>" },
      });
      expect(visualResult.isError).toBeFalsy();
      expect(resultText(visualResult)).toContain("queued for ordered display");
      const scheduleResult = await peerClient.callTool({
        name: "schedule_self",
        arguments: { delay_seconds: 60, message: "This must run on the hub." },
      });
      expect(scheduleResult.isError).toBe(true);
      expect(resultText(scheduleResult)).toContain("peer self-config bridge");
    } finally {
      await peerClient.close();
      unregister();
    }
  });

  test("send_file installs its waiter before broadcast and surfaces a synchronous failure ack", async () => {
    const filePath = join(ctx.cwd, "ack-fail.txt");
    writeFileSync(filePath, "bytes");
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type !== "message") return;
      const msg = event.payload as { id: string; topicId: string };
      if (msg.topicId !== ctx.topicId) return;
      claimDeliveryAck(msg.topicId, msg.id);
      resolveDeliveryAck(msg.topicId, msg.id, {
        ok: false,
        error: "simulated channel failure",
      });
    });
    try {
      const result = await client.callTool({
        name: "send_file",
        arguments: { file_path: filePath },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("simulated channel failure");
    } finally {
      unsubscribe();
    }
  });

  test("send_file succeeds once the delivery-ack provider confirms", async () => {
    const filePath = join(ctx.cwd, "ack-success.txt");
    writeFileSync(filePath, "bytes");
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type !== "message") return;
      const msg = event.payload as { id: string; topicId: string };
      if (msg.topicId !== ctx.topicId) return;
      claimDeliveryAck(msg.topicId, msg.id);
      resolveDeliveryAck(msg.topicId, msg.id, { ok: true });
    });
    try {
      const result = await client.callTool({
        name: "send_file",
        arguments: { file_path: filePath },
      });
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toContain("File sent to chat");
    } finally {
      unsubscribe();
    }
  });

  test("send_file without a channel claim keeps the host-storage success result", async () => {
    const filePath = join(ctx.cwd, "ack-none.txt");
    writeFileSync(filePath, "bytes");
    const result = await client.callTool({ name: "send_file", arguments: { file_path: filePath } });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("File sent to chat");
  });

  test("register_topic creates a topic owned by the token's user", async () => {
    const result = await client.callTool({
      name: "register_topic",
      arguments: { title: "worker-room", agent: "codex", description: "port scanner" },
    });
    const text = resultText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("title: worker-room");
    expect(text).toContain("agent: codex");
    expect(text).toMatch(/id: [0-9a-f-]{36}/);
    expect(text).toMatch(/model: \S+/);
  });

  test("register_topic surfaces validation errors", async () => {
    const result = await client.callTool({
      name: "register_topic",
      arguments: { title: "worker-room" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("already exists");
  });

  test("list_topics lists only the calling user's topics", async () => {
    registerTopic({ title: "other-user-room", userId: "someone-else", agent: "claude" });
    const result = await client.callTool({ name: "list_topics", arguments: {} });
    const text = resultText(result);
    expect(text).toContain('"main-room"');
    expect(text).toContain('"worker-room"');
    expect(text).toContain("idle");
    expect(text).not.toContain("other-user-room");
  });

  test("abort_topic reports idle targets and queues the abort signal", async () => {
    const result = await client.callTool({
      name: "abort_topic",
      arguments: { topic: "worker-room" },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("No active turn");

    const listed = resultText(await client.callTool({ name: "list_topics", arguments: {} }));
    const workerId = /"worker-room" \(id: ([0-9a-f-]{36})/.exec(listed)?.[1];
    const entries = readFileSync(sessionInboxPath(USER_ID, workerId!), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({ type: "abort" });
  });

  test("abort_topic refuses the current topic", async () => {
    const result = await client.callTool({
      name: "abort_topic",
      arguments: { topic: mainTopic.id },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("current topic");
  });

  test("delete_topic rejects a shared topic member without cascading into owner subagents", async () => {
    const suffix = randomUUID();
    const ownerId = `delete-owner-${suffix}`;
    const memberId = `delete-member-${suffix}`;
    const parent = registerTopic({
      title: `shared-delete-parent-${suffix}`,
      userId: ownerId,
      agent: "codex",
      surface: "otium",
    });
    parent.participants.push({ userId: memberId, role: "member" });
    upsertTopic(parent);

    const child = registerTopic({
      title: `shared-delete-child-${suffix}`,
      userId: ownerId,
      agent: "codex",
    });
    child.parentTopicId = parent.id;
    child.isSubagent = true;
    upsertTopic(child);

    const caller = registerTopic({
      title: `shared-delete-caller-${suffix}`,
      userId: memberId,
      agent: "codex",
      // Same surface as `parent` on purpose: this test is about OWNERSHIP, and
      // `resolveTopicForUser` now rejects a cross-surface id before ownership
      // is ever consulted. Leaving the caller on the default surface would
      // make it pass for the wrong reason — "not found" instead of "only the
      // topic owner". Cross-surface rejection has its own test below.
      surface: "otium",
    });
    const memberCtx: RuntimeMcpContext = {
      ...ctx,
      userId: memberId,
      actorUserId: memberId,
      // The hub confirms the member can see the parent but does not own it.
      actorTopicScope: {
        visibleNodeTopicIds: [parent.id, caller.id],
        ownedNodeTopicIds: [caller.id],
      },
      topicId: caller.id,
      topicTitle: caller.title,
    };
    const memberClient = new Client({ name: "negotium-member-delete-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken(memberCtx);
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await memberClient.connect(new StreamableHTTPClientTransport(url));
      const result = await memberClient.callTool({
        name: "delete_topic",
        arguments: { topic: parent.id, force: true },
      });
      expect(result.isError).toBe(true);
      // On Otium a room the person may see but not own is refused as "not
      // found" (the same answer a stranger gets), not with an ownership
      // message that would confirm the room and its owner exist.
      expect(resultText(result)).toContain("not found");
      expect(getTopic(parent.id)).toBeDefined();
      expect(getTopic(child.id)).toBeDefined();
    } finally {
      await memberClient.close();
    }
  });

  test("subagent management on Otium follows the hub's assertion, not the shared roster", async () => {
    const suffix = randomUUID();
    const ownerId = `subagent-owner-${suffix}`;
    const memberId = `subagent-member-${suffix}`;
    const parent = registerTopic({
      title: `shared-subagent-parent-${suffix}`,
      userId: ownerId,
      agent: "codex",
      surface: "otium",
    });
    parent.participants.push({ userId: memberId, role: "member" });
    upsertTopic(parent);
    // The node gives a worker its parent's roster verbatim, so by roster
    // alone the member "belongs" to the worker as much as the owner does.
    const worker = registerTopic({
      title: `shared-subagent-worker-${suffix}`,
      userId: ownerId,
      agent: "codex",
      surface: "otium",
    });
    worker.participants.push({ userId: memberId, role: "member" });
    worker.parentTopicId = parent.id;
    worker.isSubagent = true;
    upsertTopic(worker);

    const connect = async (userId: string, scope: RuntimeMcpContext["actorTopicScope"]) => {
      const scopedCtx: RuntimeMcpContext = {
        ...ctx,
        userId,
        actorUserId: userId,
        actorTopicScope: scope,
        topicId: parent.id,
        topicTitle: parent.title,
      };
      const scopedClient = new Client({ name: `subagent-scope-${userId}`, version: "1.0.0" });
      const token = issueRuntimeMcpToken(scopedCtx);
      await scopedClient.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
          ),
        ),
      );
      return scopedClient;
    };
    const listed = async (scopedClient: Client) =>
      (
        JSON.parse(
          resultText(await scopedClient.callTool({ name: "list_subagents", arguments: {} })),
        ) as {
          subagents: Array<{ topic_id: string }>;
        }
      ).subagents.map((child) => child.topic_id);

    // Hub says the member sees the parent only: the worker is not there.
    const stranger = await connect(memberId, {
      visibleNodeTopicIds: [parent.id],
      ownedNodeTopicIds: [],
    });
    // Hub says the member sees the worker but owns nothing: list, no delete.
    const viewer = await connect(memberId, {
      visibleNodeTopicIds: [parent.id, worker.id],
      ownedNodeTopicIds: [],
    });
    // Hub mirrors the worker into the owner's owned set: full management.
    const owner = await connect(ownerId, {
      visibleNodeTopicIds: [parent.id, worker.id],
      ownedNodeTopicIds: [parent.id, worker.id],
    });
    try {
      expect(await listed(stranger)).toEqual([]);
      const hiddenDelete = await stranger.callTool({
        name: "delete_subagent",
        arguments: { topic_id: worker.id },
      });
      expect(hiddenDelete.isError).toBe(true);
      expect(getTopic(worker.id)).toBeDefined();

      expect(await listed(viewer)).toEqual([worker.id]);
      const visibleDelete = await viewer.callTool({
        name: "delete_subagent",
        arguments: { topic_id: worker.id },
      });
      expect(visibleDelete.isError).toBe(true);
      expect(getTopic(worker.id)).toBeDefined();

      expect(await listed(owner)).toEqual([worker.id]);
      const ownedDelete = await owner.callTool({
        name: "delete_subagent",
        arguments: { topic_id: worker.id },
      });
      expect(ownedDelete.isError).not.toBe(true);
      expect(getTopic(worker.id)).toBeNull();
    } finally {
      await Promise.all([stranger.close(), viewer.close(), owner.close()]);
    }
  });

  /**
   * The destructive runtime tools take "topic title or id". The title branch
   * has always been surface-scoped; the id branch checked participation only.
   * Since a user is normally a participant of their own rooms on every
   * surface, the id was simply the way around the scope: an agent on one
   * surface could abort, restart or delete a room on another by pasting its
   * id. `delete_topic` is the destructive end of that, so it is what gets
   * pinned here.
   */
  test("delete_topic refuses a topic id from another surface", async () => {
    const suffix = randomUUID();
    const ownerId = `xsurface-owner-${suffix}`;
    const victim = registerTopic({
      title: `xsurface-victim-${suffix}`,
      userId: ownerId,
      agent: "codex",
      surface: "otium",
    });

    // Same user, so participation cannot be what rejects this — only surface.
    const caller = registerTopic({
      title: `xsurface-caller-${suffix}`,
      userId: ownerId,
      agent: "codex",
      surface: "telegram",
    });
    const callerCtx: RuntimeMcpContext = {
      ...ctx,
      userId: ownerId,
      topicId: caller.id,
      topicTitle: caller.title,
    };
    const crossClient = new Client({ name: "negotium-xsurface-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken(callerCtx);
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await crossClient.connect(new StreamableHTTPClientTransport(url));
      const result = await crossClient.callTool({
        name: "delete_topic",
        arguments: { topic: victim.id, force: true },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("not found");
      expect(getTopic(victim.id)).toBeDefined();
    } finally {
      await crossClient.close();
    }
  });

  test("restart_topic clears AI context but preserves the topic", async () => {
    const worker = getTopicByNameForUser("worker-room", USER_ID, { scope: "all" })!;
    setTopicSessionId(worker.id, "01940000-0000-7000-8000-000000000000", {
      reason: "test",
      agent: "codex",
    });

    const result = await client.callTool({
      name: "restart_topic",
      arguments: { topic: worker.id },
    });

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('Session reset for "worker-room"');
    expect(getTopicSessionId(worker.id)).toBeNull();
    expect(getTopicByNameForUser("worker-room", USER_ID, { scope: "all" })?.id).toBe(worker.id);
  });

  test("restart_topic refuses the current topic", async () => {
    const result = await client.callTool({
      name: "restart_topic",
      arguments: { topic: mainTopic.id },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("current topic");
  });

  /**
   * A hub creates every room it backs under its own execution principal and
   * keeps per-person membership in its own store, so scoping the Otium surface
   * by the turn's user matched nothing: the manager room reported "one topic",
   * naming only the private General this node had just made for that person,
   * while the workspace it spoke for held all the rooms.
   *
   * The workspace is the outer boundary, not the listing: which of its rooms
   * the person may name is the hub's per-turn assertion (`actorTopicScope`),
   * since only the hub knows who is in which room. This used to list every
   * room in the workspace, which let a member's agent see — and abort — rooms
   * that member was never invited to.
   */
  test("list_topics on the Otium surface lists the hub-asserted rooms inside the workspace", async () => {
    const suffix = randomUUID();
    // The hub files every room it backs under its own execution principal.
    const hubPrincipal = NODE_LOCAL_USER_ID;
    const person = `hub-person-${suffix}`;
    const scope = `workspace-${suffix}`;

    const backed = registerTopic({
      title: `hub-room-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    const otherWorkspace = registerTopic({
      title: `other-workspace-room-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: `other-${suffix}`,
    });
    const uninvited = registerTopic({
      title: `hub-private-room-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    const humanOnly = registerTopic({
      title: `hub-human-room-${suffix}`,
      userId: hubPrincipal,
      kind: "channel",
      agent: "none",
      surface: "otium",
      surfaceScope: scope,
    });
    const general = ensurePersonalGeneral(person, "otium", { surfaceScope: scope });
    const someoneElsesGeneral = ensurePersonalGeneral(`bystander-${suffix}`, "otium", {
      surfaceScope: scope,
    });

    const callerCtx: RuntimeMcpContext = {
      ...ctx,
      userId: person,
      actorUserId: person,
      // The hub says: this person is in `backed`, `humanOnly` (and their
      // General) but only owns the General and the human-only room;
      // `uninvited` and `otherWorkspace` are not mentioned.
      actorTopicScope: {
        visibleNodeTopicIds: [backed.id, humanOnly.id, general.id, otherWorkspace.id],
        ownedNodeTopicIds: [general.id, humanOnly.id],
      },
      topicId: general.id,
      topicTitle: general.title,
    };
    const managerClient = new Client({ name: "negotium-otium-manager-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken(callerCtx);
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await managerClient.connect(new StreamableHTTPClientTransport(url));
      const text = resultText(await managerClient.callTool({ name: "list_topics", arguments: {} }));
      expect(text).toContain(backed.id);
      // The room this turn is speaking from — here the person's General — is
      // not a target of anything, so it is not offered as one.
      expect(text).not.toContain(general.id);
      // Nor is a room whose AI is off: there is no turn to abort or restart
      // and nothing to tell, so it is left out even though the hub asserts it.
      expect(text).not.toContain(humanOnly.id);
      // A room in the workspace the hub did not assert for this person is
      // invisible — the listing is the assertion, not the workspace.
      expect(text).not.toContain(uninvited.id);
      // Another workspace on the same node stays out even when a (buggy or
      // stale) assertion names it: the workspace boundary is still applied.
      expect(text).not.toContain(otherWorkspace.id);
      // Another person's private General inside this one stays out too.
      expect(text).not.toContain(someoneElsesGeneral.id);
      // The terminal rooms this node also holds are a different surface.
      expect(text).not.toContain(mainTopic.id);

      // Visible is not owned: a member may see `backed` but stopping its work
      // is the owner's call, and the refusal reads exactly like "no such room".
      const aborted = await managerClient.callTool({
        name: "abort_topic",
        arguments: { topic: backed.id },
      });
      expect(aborted.isError).toBe(true);
      expect(resultText(aborted)).toContain("not found");
      const restarted = await managerClient.callTool({
        name: "restart_topic",
        arguments: { topic: backed.id },
      });
      expect(restarted.isError).toBe(true);
      expect(resultText(restarted)).toContain("not found");
      const deleted = await managerClient.callTool({
        name: "delete_topic",
        arguments: { topic: backed.id, force: true },
      });
      expect(deleted.isError).toBe(true);
      expect(resultText(deleted)).toContain("not found");
      expect(getTopic(backed.id)).not.toBeNull();

      // A room the hub never asserted is "not found" for every tool, by id or
      // by title, so its existence never leaks through an error message. The
      // asserted-but-AI-off room answers the same way: excluded from the
      // listing, it cannot be a target either.
      for (const name of ["abort_topic", "restart_topic", "delete_topic"]) {
        for (const ref of [uninvited.title, humanOnly.id]) {
          const refused = await managerClient.callTool({ name, arguments: { topic: ref } });
          expect(refused.isError).toBe(true);
          expect(resultText(refused)).toContain("not found");
        }
      }
      expect(getTopic(uninvited.id)).not.toBeNull();
      expect(getTopic(humanOnly.id)).not.toBeNull();
      // The current room stays precisely refused, not "not found": the caller
      // is told what is actually wrong with aborting the room it speaks from.
      const self = await managerClient.callTool({
        name: "abort_topic",
        arguments: { topic: general.id },
      });
      expect(self.isError).toBe(true);
      expect(resultText(self)).toContain("current topic");
    } finally {
      await managerClient.close();
    }
  });

  test("Otium lifecycle tools act on a room the hub asserts the person owns", async () => {
    const suffix = randomUUID();
    const hubPrincipal = NODE_LOCAL_USER_ID;
    const person = `hub-owner-${suffix}`;
    const scope = `workspace-owner-${suffix}`;
    const owned = registerTopic({
      title: `hub-owned-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    const general = ensurePersonalGeneral(person, "otium", { surfaceScope: scope });
    const managerClient = new Client({ name: "negotium-otium-owner-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      userId: person,
      actorUserId: person,
      actorTopicScope: {
        visibleNodeTopicIds: [owned.id, general.id],
        ownedNodeTopicIds: [owned.id, general.id],
      },
      topicId: general.id,
      topicTitle: general.title,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );
    try {
      await managerClient.connect(new StreamableHTTPClientTransport(url));
      const aborted = await managerClient.callTool({
        name: "abort_topic",
        arguments: { topic: owned.id },
      });
      expect(aborted.isError).toBeFalsy();
      const restarted = await managerClient.callTool({
        name: "restart_topic",
        arguments: { topic: owned.title },
      });
      expect(restarted.isError).toBeFalsy();
      const deleted = await managerClient.callTool({
        name: "delete_topic",
        arguments: { topic: owned.id, force: true },
      });
      expect(deleted.isError).toBeFalsy();
      expect(getTopic(owned.id)).toBeNull();
    } finally {
      await managerClient.close();
    }
  });

  /**
   * A room's subagent workers are reachable through lineage only for turns no
   * person started. Once a person speaks, the hub's assertion is the whole
   * story: it mirrors a worker with its parent's roster, so the parent's
   * owner is asserted as the worker's owner — and a member who merely shares
   * the parent is not, and must not inherit the parent's delegation.
   */
  test("Otium lifecycle tools on a subagent worker follow the assertion, not the parent's lineage", async () => {
    const suffix = randomUUID();
    const hubPrincipal = NODE_LOCAL_USER_ID;
    const scope = `workspace-lineage-${suffix}`;
    const parent = registerTopic({
      title: `hub-parent-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    const worker = registerTopic({
      title: `hub-worker-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    upsertTopic({ ...worker, parentTopicId: parent.id, isSubagent: true });
    const connect = async (actorTopicScope: RuntimeMcpContext["actorTopicScope"]) => {
      const c = new Client({ name: `negotium-otium-lineage-${randomUUID()}`, version: "1.0.0" });
      const token = issueRuntimeMcpToken({
        ...ctx,
        userId: hubPrincipal,
        actorUserId: `person-${suffix}`,
        actorTopicScope,
        topicId: parent.id,
        topicTitle: parent.title,
      });
      await c.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
          ),
        ),
      );
      return c;
    };

    // A member of the shared parent who does not own it: the worker is not
    // in their assertion, so it is "not found" for every lifecycle tool.
    const member = await connect({ visibleNodeTopicIds: [parent.id], ownedNodeTopicIds: [] });
    try {
      const listed = resultText(await member.callTool({ name: "list_topics", arguments: {} }));
      expect(listed).not.toContain(worker.id);
      for (const name of ["abort_topic", "restart_topic", "delete_topic"]) {
        for (const ref of [worker.id, worker.title]) {
          const refused = await member.callTool({ name, arguments: { topic: ref, force: true } });
          expect(refused.isError).toBe(true);
          expect(resultText(refused)).toContain("not found");
        }
      }
      expect(getTopic(worker.id)).not.toBeNull();
    } finally {
      await member.close();
    }

    // The parent's owner: the hub asserts the mirrored worker as owned, and
    // that — not the lineage — is what allows it.
    const owner = await connect({
      visibleNodeTopicIds: [parent.id, worker.id],
      ownedNodeTopicIds: [parent.id, worker.id],
    });
    try {
      const listed = resultText(await owner.callTool({ name: "list_topics", arguments: {} }));
      expect(listed).toContain(worker.id);
      const aborted = await owner.callTool({
        name: "abort_topic",
        arguments: { topic: worker.id },
      });
      expect(aborted.isError).toBeFalsy();
      const deleted = await owner.callTool({
        name: "delete_topic",
        arguments: { topic: worker.id, force: true },
      });
      expect(deleted.isError).toBeFalsy();
      expect(getTopic(worker.id)).toBeNull();
    } finally {
      await owner.close();
    }
  });

  /**
   * No assertion means the hub is older than this node, or the turn was not
   * started by a person (cron, self-schedule, subagent, peer bridge). The
   * node cannot reconstruct membership on its own, so it fails closed: the
   * current room is the only room these tools know about.
   */
  test("without a hub assertion, Otium tools see only the current room", async () => {
    const suffix = randomUUID();
    const hubPrincipal = NODE_LOCAL_USER_ID;
    const person = `hub-legacy-${suffix}`;
    const scope = `workspace-legacy-${suffix}`;
    const other = registerTopic({
      title: `hub-other-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    const current = registerTopic({
      title: `hub-current-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    const client2 = new Client({ name: "negotium-otium-legacy-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      userId: hubPrincipal,
      actorUserId: person,
      topicId: current.id,
      topicTitle: current.title,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );
    try {
      await client2.connect(new StreamableHTTPClientTransport(url));
      const text = resultText(await client2.callTool({ name: "list_topics", arguments: {} }));
      // The current room is never a target, so with no assertion there is
      // nothing to list at all.
      expect(text).toContain("No topics found");
      expect(text).not.toContain(current.id);
      expect(text).not.toContain(other.id);
      for (const name of ["abort_topic", "restart_topic", "delete_topic"]) {
        const refused = await client2.callTool({ name, arguments: { topic: other.id } });
        expect(refused.isError).toBe(true);
        expect(resultText(refused)).toContain("not found");
      }
      expect(getTopic(other.id)).not.toBeNull();
      // The current room still resolves, so the refusal names the real reason.
      const self = await client2.callTool({
        name: "restart_topic",
        arguments: { topic: current.id },
      });
      expect(self.isError).toBe(true);
      expect(resultText(self)).toContain("current topic");
    } finally {
      await client2.close();
    }
  });

  /**
   * No person owns a hub-backed room on this node, so an owner check against
   * the turn's user could never pass: the manager room could see every room in
   * its workspace and was refused every one of them with "only the topic owner
   * can delete it". The node still administers the room as its own principal —
   * but only once the hub has asserted that the calling person owns it.
   */
  test("delete_topic administers a hub-backed room as the room's own owner", async () => {
    const suffix = randomUUID();
    const hubPrincipal = NODE_LOCAL_USER_ID;
    const person = `hub-person-delete-${suffix}`;
    const scope = `workspace-delete-${suffix}`;

    const backed = registerTopic({
      title: `hub-doomed-${suffix}`,
      userId: hubPrincipal,
      agent: "codex",
      surface: "otium",
      surfaceScope: scope,
    });
    const general = ensurePersonalGeneral(person, "otium", { surfaceScope: scope });

    const managerClient = new Client({ name: "negotium-otium-delete-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({
      ...ctx,
      userId: person,
      actorUserId: person,
      actorTopicScope: {
        visibleNodeTopicIds: [backed.id, general.id],
        ownedNodeTopicIds: [backed.id, general.id],
      },
      topicId: general.id,
      topicTitle: general.title,
    });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await managerClient.connect(new StreamableHTTPClientTransport(url));
      const result = await managerClient.callTool({
        name: "delete_topic",
        arguments: { topic: backed.id, force: true },
      });
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toContain("deleted");
      expect(getTopic(backed.id)).toBeNull();

      // A manager room is still nobody's to delete, including one's own.
      const refused = await managerClient.callTool({
        name: "delete_topic",
        arguments: { topic: general.id, force: true },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await managerClient.close();
    }
  });
});
