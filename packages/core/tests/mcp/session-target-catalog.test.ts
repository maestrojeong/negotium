import { describe, expect, test } from "bun:test";
import { createSessionTargetCatalog, type SessionTopicRow } from "#mcp/session-comm/topic-catalog";

const rows: SessionTopicRow[] = [
  {
    id: "current",
    title: "Current",
    kind: "agent",
    agent: "codex",
    sessionId: "current-session",
    description: null,
  },
  {
    id: "manager",
    title: "Manager",
    kind: "manager",
    agent: "maestro",
    sessionId: "manager-session",
    description: null,
  },
  {
    id: "agent-shared",
    title: "Shared",
    kind: "agent",
    agent: "codex",
    sessionId: "agent-session",
    description: "Agent target",
  },
  {
    id: "channel-shared",
    title: "shared",
    kind: "channel",
    agent: null,
    sessionId: null,
    description: null,
  },
  {
    id: "unique",
    title: "Unique",
    kind: "agent",
    agent: "claude",
    sessionId: null,
    description: null,
  },
  {
    id: "agent-duplicate-a",
    title: "Duplicate",
    kind: "agent",
    agent: "codex",
    sessionId: null,
    description: null,
  },
  {
    id: "agent-duplicate-b",
    title: "duplicate",
    kind: "agent",
    agent: "claude",
    sessionId: null,
    description: null,
  },
];

function createCatalog() {
  return createSessionTargetCatalog({
    currentTopicId: "current",
    currentTopicName: "Current",
    isAgent: (value): value is "codex" | "claude" => value === "codex" || value === "claude",
    listRows: () => rows,
  });
}

describe("createSessionTargetCatalog", () => {
  test("filters current and manager rows and qualifies colliding titles", () => {
    const catalog = createCatalog();

    expect(catalog.listTargets().map(({ key }) => key)).toEqual([
      "agent:Shared",
      "channel:shared",
      "Unique",
      "agent:Duplicate:agent-duplicate-a",
      "agent:duplicate:agent-duplicate-b",
    ]);
    expect(catalog.getTopics()["agent:Shared"]?.topicId).toBe("agent-shared");
    expect(catalog.getTopics()["channel:shared"]?.topicId).toBe("channel-shared");
    expect(catalog.getTopics().Unique?.sessionId).toBe("");
    expect(catalog.getTopics().Current).toBeUndefined();
    expect(catalog.getTopics()["agent:Duplicate"]).toBeUndefined();
    expect(catalog.getTopics()["agent:Duplicate:agent-duplicate-a"]?.topicId).toBe(
      "agent-duplicate-a",
    );
  });

  test("validates targets and only advertises AI-capable aliases", () => {
    const catalog = createCatalog();

    expect(catalog.validateTarget("Unique")).toEqual({
      ok: true,
      target: catalog.getTopics().Unique,
    });
    const missing = catalog.validateTarget("missing");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.content[0]?.text).toContain("agent:Shared");
      expect(missing.error.content[0]?.text).toContain("Unique");
      expect(missing.error.content[0]?.text).not.toContain("channel:shared");
    }
  });

  test("keeps state isolated between hosts", () => {
    const first = createCatalog();
    const second = createSessionTargetCatalog({
      isAgent: (value): value is "maestro" => value === "maestro",
      listRows: () => [
        {
          id: "other",
          title: "Other",
          kind: "agent",
          agent: "maestro",
          sessionId: null,
          description: null,
        },
      ],
    });

    expect(first.getTopics().Other).toBeUndefined();
    expect(second.getTopics().Shared).toBeUndefined();
    expect(second.getTopics().Other?.agent).toBe("maestro");
  });
});
