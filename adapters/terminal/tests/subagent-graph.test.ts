import { describe, expect, test } from "bun:test";
import type { TopicDto } from "@negotium/core";
import {
  adjustSubagentGraphSpacing,
  appendElkOutput,
  buildSubagentGraph,
  layoutSubagentGraph,
  MAX_SUBAGENT_GRAPH_SPACING,
  MIN_SUBAGENT_GRAPH_SPACING,
} from "@/subagent-graph";

function topic(id: string, title: string, parentTopicId?: string): TopicDto {
  return {
    id,
    title,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    isSubagent: Boolean(parentTopicId),
    parentTopicId,
    participants: [{ userId: "local", role: "owner" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("subagent graph", () => {
  test("clamps user-controlled graph spacing", () => {
    expect(adjustSubagentGraphSpacing(4, -1)).toBe(3);
    expect(adjustSubagentGraphSpacing(MIN_SUBAGENT_GRAPH_SPACING, -1)).toBe(
      MIN_SUBAGENT_GRAPH_SPACING,
    );
    expect(adjustSubagentGraphSpacing(MAX_SUBAGENT_GRAPH_SPACING, 1)).toBe(
      MAX_SUBAGENT_GRAPH_SPACING,
    );
  });

  test("rejects oversized ELK process output", () => {
    expect(appendElkOutput("1234", "56", 6)).toBe("123456");
    expect(() => appendElkOutput("1234", "567", 6)).toThrow("ELK output exceeded 6 bytes");
  });

  test("includes ownership and tell edges below the current topic", () => {
    const root = topic("root", "Review");
    const scope = {
      ...topic("scope", "Scope Lead", root.id),
      subagentTellTargetIds: ["safety"],
    };
    const safety = topic("safety", "Safety Lead", root.id);
    const mapper = topic("mapper", "Diff Mapper", scope.id);

    const graph = buildSubagentGraph([mapper, scope, safety, root], root.id, new Set([scope.id]));

    expect(graph.nodes.map(({ id, title, running }) => ({ id, title, running }))).toEqual([
      { id: "root", title: "Review", running: false },
      { id: "scope", title: "Scope Lead", running: true },
      { id: "mapper", title: "Diff Mapper", running: false },
      { id: "safety", title: "Safety Lead", running: false },
    ]);
    expect(graph.edges).toEqual([
      { id: "owns:root:scope", source: "root", target: "scope", kind: "owns" },
      { id: "tell:scope:safety", source: "scope", target: "safety", kind: "tell" },
      { id: "owns:scope:mapper", source: "scope", target: "mapper", kind: "owns" },
      { id: "owns:root:safety", source: "root", target: "safety", kind: "owns" },
    ]);
  });

  test("shows only the current subagent and its descendants", () => {
    const root = topic("root", "Root");
    const current = topic("current", "Current", root.id);
    const child = topic("child", "Child", current.id);
    const sibling = topic("sibling", "Sibling", root.id);

    const graph = buildSubagentGraph([root, current, child, sibling], current.id);

    expect(graph.nodes.map((node) => node.id)).toEqual(["current", "child"]);
    expect(graph.edges).toEqual([
      { id: "owns:current:child", source: "current", target: "child", kind: "owns" },
    ]);
  });

  test("shows status-only ownership as parent-to-child communication", async () => {
    const root = topic("root", "Root");
    const child = {
      ...topic("child", "Status Worker", root.id),
      subagentReportMode: "status-only" as const,
    };

    const graph = buildSubagentGraph([root, child], root.id);

    expect(graph.edges).toEqual([
      {
        id: "owns-parent-only:root:child",
        source: "root",
        target: "child",
        kind: "owns-parent-only",
      },
    ]);
    const output = (await layoutSubagentGraph(graph)).lines.join("\n");
    expect(output).toContain("status only ↓");
    expect(output).not.toContain("▲");
  });

  test("includes sibling boundary nodes connected by tell grants", () => {
    const root = topic("root", "Root");
    const current = {
      ...topic("current", "Current", root.id),
      subagentTellTargetIds: ["sibling"],
    };
    const sibling = topic("sibling", "Sibling", root.id);

    const graph = buildSubagentGraph([root, current, sibling], current.id);

    expect(graph.nodes.map((node) => node.id)).toEqual(["current", "sibling"]);
    expect(graph.edges).toContainEqual({
      id: "tell:current:sibling",
      source: "current",
      target: "sibling",
      kind: "tell",
    });
  });

  test("collapses reciprocal tell grants into one bidirectional edge", async () => {
    const root = topic("root", "Root");
    const first = {
      ...topic("first", "First", root.id),
      subagentTellTargetIds: ["second"],
    };
    const second = {
      ...topic("second", "Second", root.id),
      subagentTellTargetIds: ["first"],
    };

    const graph = buildSubagentGraph([root, first, second], root.id);
    const tellEdges = graph.edges.filter((edge) => edge.kind !== "owns");

    expect(tellEdges).toEqual([
      {
        id: "tell-bidirectional:first:second",
        source: "first",
        target: "second",
        kind: "tell-bidirectional",
      },
    ]);
    expect((await layoutSubagentGraph(graph)).lines.join("\n")).toContain("tell ↔");
  });

  test("renders an ELK layout into a terminal canvas", async () => {
    const root = topic("root", "루트");
    const child = topic("child", "Child", root.id);

    const canvas = await layoutSubagentGraph(buildSubagentGraph([root, child], root.id));
    const output = canvas.lines.join("\n");

    expect(canvas.width).toBeGreaterThan(10);
    expect(canvas.height).toBeGreaterThan(8);
    expect(output).toContain("○ 루트");
    expect(output).toContain("○ Child");
    expect(output).toContain("▲");
    expect(output).toContain("▼");
  });

  test("preserves a full title when it is as wide as the detail line", async () => {
    const root = {
      ...topic("root", "AAAAAAAAAAAAAAAA"),
      agent: "codex" as const,
      defaultModel: "x",
      defaultEffort: "low" as const,
    };

    const output = (await layoutSubagentGraph(buildSubagentGraph([root], root.id))).lines.join(
      "\n",
    );

    expect(output).toContain("AAAAAAAAAAAAAAAA");
  });

  test("expands the ELK canvas when graph spacing increases", async () => {
    const root = topic("root", "Root");
    const child = topic("child", "Child", root.id);
    const graph = buildSubagentGraph([root, child], root.id);

    const compact = await layoutSubagentGraph(graph, MIN_SUBAGENT_GRAPH_SPACING);
    const spacious = await layoutSubagentGraph(graph, MAX_SUBAGENT_GRAPH_SPACING);

    expect(spacious.height).toBeGreaterThan(compact.height);
  });

  test("cancels an ELK layout through AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();
    const graph = buildSubagentGraph([topic("root", "Root")], "root");

    await expect(
      layoutSubagentGraph(graph, MIN_SUBAGENT_GRAPH_SPACING, controller.signal),
    ).rejects.toThrow();
  });
});
