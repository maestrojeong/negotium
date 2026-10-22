import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { submitRuntimeGatewayTurn } from "#application/submit-runtime-gateway-turn";
import { getMcpServersForQuery } from "#platform/mcp-config";
import { resolveTurnHostMcpServers } from "#runtime/turn-runner";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { deleteTopicHostMcpGrant, recordTopicHostMcpGrant } from "#storage/topic-host-mcp-grants";
import { registerTopic } from "#topics/create";
import { ensurePersonalGeneral } from "#topics/personal-general";

const topicIds = new Set<string>();
const grant = {
  "topic-admin": {
    type: "http" as const,
    url: "http://127.0.0.1:4200/mcp/admin/topic-admin/mcp?token=persistent",
  },
};

afterEach(() => {
  for (const topicId of topicIds) {
    deleteTopicHostMcpGrant(topicId);
    deleteTopic(topicId, { allowManager: true });
  }
  topicIds.clear();
});

test("adapter-less manager turns resolve the durable host MCP grant", () => {
  const manager = ensurePersonalGeneral(`host-grant-manager-${randomUUID()}`, "otium");
  topicIds.add(manager.id);
  recordTopicHostMcpGrant(manager.id, grant);

  // This is the same no-per-turn-input resolution used by tell/subagent-report/
  // auto-continue paths before the provider MCP catalog is built.
  const resolved = resolveTurnHostMcpServers(manager);
  expect(resolved).toEqual(grant);
  expect(
    getMcpServersForQuery({
      agent: "codex",
      prompt: "continue",
      systemPrompt: "",
      cwd: "/tmp",
      userId: manager.participants[0]?.userId,
      sessionType: "manager",
      session: "General",
      topicId: manager.id,
      hostMcpServers: resolved,
    })["topic-admin"],
  ).toEqual(grant["topic-admin"]);
});

test("non-manager scopes and subagent rooms never receive a stored manager grant", () => {
  const owner = `host-grant-scope-${randomUUID()}`;
  const manager = ensurePersonalGeneral(owner, "otium");
  const child = registerTopic({
    title: `Host grant child ${randomUUID()}`,
    userId: owner,
    agent: "codex",
  });
  const subagent = { ...child, parentTopicId: manager.id, isSubagent: true };
  upsertTopic(subagent);
  topicIds.add(manager.id);
  topicIds.add(child.id);
  recordTopicHostMcpGrant(manager.id, grant);
  // Simulate stale/corrupt durable state to assert the execution boundary also
  // checks topic kind instead of trusting that ingress was the only writer.
  recordTopicHostMcpGrant(child.id, grant);

  expect(resolveTurnHostMcpServers(manager, "forum")).toBeUndefined();
  expect(resolveTurnHostMcpServers(manager, "cron")).toBeUndefined();
  expect(resolveTurnHostMcpServers(subagent)).toBeUndefined();
  expect(resolveTurnHostMcpServers(subagent, "manager")).toBeUndefined();
});

test("an ordinary room's grant reaches only its own forum executions", () => {
  const owner = `host-grant-forum-${randomUUID()}`;
  const room = registerTopic({ title: `Host grant room ${randomUUID()}`, userId: owner });
  topicIds.add(room.id);
  const roomGrant = {
    tax: { type: "http" as const, url: "http://127.0.0.1:4200/mcp/tax/mcp?token=room" },
  };
  submitRuntimeGatewayTurn({
    topic: room,
    userId: owner,
    text: "which tools can I use",
    clientMessageId: randomUUID(),
    respond: false,
    hostMcpServers: roomGrant,
  });

  const resolved = resolveTurnHostMcpServers(room);
  expect(resolved).toEqual(roomGrant);
  expect(resolveTurnHostMcpServers(room, "cron")).toBeUndefined();
  expect(resolveTurnHostMcpServers(room, "ephemeral")).toBeUndefined();
  expect(resolveTurnHostMcpServers(room, "manager")).toBeUndefined();
  expect(
    getMcpServersForQuery({
      agent: "codex",
      prompt: "which tools can I use",
      systemPrompt: "",
      cwd: "/tmp",
      userId: owner,
      sessionType: "forum",
      session: room.title,
      topicId: room.id,
      hostMcpServers: resolved,
    }).tax,
  ).toEqual(roomGrant.tax);
});

test("ordinary and subagent rooms refuse the manager administration surface", () => {
  const owner = `host-grant-refuse-${randomUUID()}`;
  const manager = ensurePersonalGeneral(owner, "otium");
  const room = registerTopic({ title: `Host grant refuse ${randomUUID()}`, userId: owner });
  const subagent = { ...room, parentTopicId: manager.id, isSubagent: true };
  topicIds.add(manager.id);
  topicIds.add(room.id);
  const submit = (topic: typeof room, hostMcpServers: Record<string, unknown>) =>
    submitRuntimeGatewayTurn({
      topic,
      userId: owner,
      text: "reject before persistence",
      clientMessageId: randomUUID(),
      respond: false,
      hostMcpServers: hostMcpServers as never,
    });
  const tax = { type: "http", url: "http://127.0.0.1:4200/mcp/tax/mcp?token=room" };

  expect(() => submit(room, { "topic-admin": grant["topic-admin"] })).toThrow(
    "topic-admin is only allowed for manager topics",
  );
  expect(() => submit(subagent, { tax })).toThrow("not allowed for subagent topics");
});

test("the public submit boundary rejects unsafe and node-owned grants", () => {
  const manager = ensurePersonalGeneral(`host-grant-submit-${randomUUID()}`, "otium");
  topicIds.add(manager.id);
  const submit = (hostMcpServers: Record<string, never>) =>
    submitRuntimeGatewayTurn({
      topic: manager,
      userId: manager.participants[0]?.userId ?? "local",
      text: "reject before persistence",
      clientMessageId: randomUUID(),
      respond: false,
      hostMcpServers,
    });

  expect(() => submit({ shell: { command: "bash" } } as never)).toThrow("command is not allowed");
  expect(() =>
    submit({ runtime: { type: "http", url: "http://127.0.0.1:4200/mcp" } } as never),
  ).toThrow("conflicts with node catalog: runtime");
});
