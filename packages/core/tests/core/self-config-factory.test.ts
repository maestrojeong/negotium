import { describe, expect, test } from "bun:test";
import { createSelfConfigRuntime, type SelfConfigRuntime } from "#agents/mcp-tools/self-config";
import type {
  SelfConfigField,
  SelfConfigHost,
  SelfConfigTopic,
  SelfConfigTopicConfig,
} from "#agents/self-config-core";

const TOPIC: SelfConfigTopic = {
  id: "host-topic",
  title: "Host Topic",
  agent: "maestro",
  defaultModel: "host-default",
  defaultEffort: "medium",
  participants: [{ userId: "host-user" }],
};

function tool(runtime: SelfConfigRuntime, name: string) {
  const found = runtime
    .createToolDefinitions({
      topicId: TOPIC.id,
      userId: "host-user",
    })
    .find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool: ${name}`);
  return found;
}

function text(result: Awaited<ReturnType<ReturnType<typeof tool>["handler"]>>): string {
  const content = result.content[0];
  return content && content.type === "text" ? content.text : "";
}

function createHost(overrides: Partial<SelfConfigHost> = {}) {
  let config: SelfConfigTopicConfig | undefined;
  const changes: SelfConfigField[] = [];
  const authChecks: string[] = [];
  const host: SelfConfigHost = {
    topics: {
      getTopic: (topicId) => (topicId === TOPIC.id ? TOPIC : null),
      getConfig: () => config,
      setConfig: (_topicId, next) => {
        config = next;
      },
    },
    models: {
      forAgent: () => ({
        defaultEffort: "medium",
        validEfforts: ["low", "medium", "high"],
        validateModel: (model) => model === "host-alias" || model === "host-canonical",
        validateEffort: (effort) => ["low", "medium", "high"].includes(effort),
        resolveModel: (model) =>
          !model || model === "host-default" || model === "host-alias" ? "host-canonical" : model,
      }),
      owner: () => "maestro",
      checkAuth: (_agent, model) => {
        authChecks.push(model);
        return { ok: true };
      },
    },
    runtime: {
      resolveWorkspaceDir: () => "/host/workspace",
      switchAgent: (options) => ({
        ok: true,
        outcome: { kind: "fresh", agent: options.agent, reason: "no-history" },
      }),
      configChanged: (_topicId, field) => changes.push(field),
    },
    ...overrides,
  };
  return {
    host,
    changes,
    authChecks,
    getConfig: () => config,
  };
}

describe("self-config host factory", () => {
  test("one runtime applies injected policy through its MCP wrapper", async () => {
    const state = createHost();
    const runtime = createSelfConfigRuntime({
      host: state.host,
      product: {
        mcpKey: "host-topic-config",
        toolDescriptions: { set_model: "Host-specific model policy." },
      },
    });

    const setModel = tool(runtime, "set_model");
    const result = await setModel.handler({ model: "host-alias" });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("'host-canonical'");
    expect(setModel.description).toBe("Host-specific model policy.");
    expect(runtime.mcpKey).toBe("host-topic-config");
    expect(state.getConfig()?.model).toBe("host-canonical");
    expect(state.authChecks).toEqual(["host-canonical"]);
    expect(state.changes).toEqual(["model"]);
    expect(runtime.core.getModel({ topicId: TOPIC.id, userId: "host-user" }).text).toContain(
      "host-canonical",
    );
  });

  test("tool surface follows optional host capabilities", () => {
    const runtime = createSelfConfigRuntime({ host: createHost().host });
    const names = runtime
      .createToolDefinitions({ topicId: TOPIC.id, userId: "host-user" })
      .map((candidate) => candidate.name);

    expect(names).toEqual([
      "set_model",
      "get_model",
      "set_agent",
      "get_agent",
      "set_effort",
      "get_effort",
    ]);
  });

  test("derived-topic policy and MCP limit share the same product config", async () => {
    let deriveCalls = 0;
    const state = createHost({
      derivedTopics: {
        create: async (_topicId, _userId, copyHistory) => {
          deriveCalls++;
          return { ...TOPIC, id: `child-${deriveCalls}`, title: copyHistory ? "Fork" : "Spawn" };
        },
        link: (topicId) => `topic:${topicId}`,
        isTitleConflict: () => false,
        isForkCompactionError: () => false,
      },
    });
    const runtime = createSelfConfigRuntime({
      host: state.host,
      product: { derivedTopicLimit: 1 },
    });
    const definitions = runtime.createToolDefinitions({
      topicId: TOPIC.id,
      userId: "host-user",
    });
    const spawn = definitions.find((candidate) => candidate.name === "spawn_topic");
    const fork = definitions.find((candidate) => candidate.name === "fork_topic");
    if (!spawn || !fork) throw new Error("missing derived-topic tools");

    expect(text(await spawn.handler({}))).toContain("topic:child-1");
    const limited = await fork.handler({});
    expect(limited.isError).toBe(true);
    expect(text(limited)).toContain("only 1 spawn/fork");
    expect(deriveCalls).toBe(1);
  });

  test("freezes product policy before MCP schemas capture its limits", () => {
    const runtime = createSelfConfigRuntime({
      host: createHost().host,
      product: {
        scheduleMaxDelaySeconds: 60,
        toolDescriptions: { schedule_self: "Frozen schedule policy." },
      },
    });

    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.core)).toBe(true);
    expect(Object.isFrozen(runtime.core.product)).toBe(true);
    expect(Object.isFrozen(runtime.core.product.toolDescriptions)).toBe(true);
    expect(() => {
      (runtime.core.product as { scheduleMaxDelaySeconds: number }).scheduleMaxDelaySeconds = 120;
    }).toThrow();
    expect(() => {
      (runtime.core.product.toolDescriptions as Record<string, string>).schedule_self = "Changed";
    }).toThrow();
    expect(runtime.core.product.scheduleMaxDelaySeconds).toBe(60);
    expect(runtime.core.product.toolDescriptions.schedule_self).toBe("Frozen schedule policy.");
  });

  test("rejects invalid product policy limits at factory creation", () => {
    for (const product of [
      { scheduleMaxDelaySeconds: 0 },
      { scheduleMaxMessageLength: -1 },
      { derivedTopicLimit: 1.5 },
    ]) {
      expect(() => createSelfConfigRuntime({ host: createHost().host, product })).toThrow(
        "must be a positive integer",
      );
    }
  });
});
