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
