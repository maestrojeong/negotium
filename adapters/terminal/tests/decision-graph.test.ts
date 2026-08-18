import { describe, expect, test } from "bun:test";
import type { DecisionSnapshot } from "@negotium/core";
import {
  adjustDecisionGraphSpacing,
  buildDecisionGraph,
  layoutDecisionGraph,
  MAX_DECISION_GRAPH_SPACING,
  MIN_DECISION_GRAPH_SPACING,
  renderDecisionGraph,
} from "@/decision-graph";

const decision = (
  id: string,
  action: string,
  status: DecisionSnapshot["status"],
  causedBy?: string[],
): DecisionSnapshot => ({
  id,
  action,
  reasoning: `Why ${action}`,
  agent: "codex",
  model: "gpt-5.6-sol",
  status,
  causedBy,
  timestamp: 1,
});

describe("decision graph", () => {
  test("projects causal references into directed Orchgraph edges", () => {
    const graph = buildDecisionGraph(
      [
        decision("1", "Choose TypeScript", "executed"),
        decision("2", "Use MCP", "accepted", ["1"]),
        decision("3", "Use Orchgraph", "proposed", ["1", "2"]),
      ],
      "Architecture",
    );
    expect(graph.nodes.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "1", state: "succeeded" },
      { id: "2", state: "idle" },
      { id: "3", state: "queued" },
    ]);
    expect(
      graph.edges.map(({ source, target, direction, kind }) => ({
        source,
        target,
        direction,
        kind,
      })),
    ).toEqual([
      { source: "1", target: "2", direction: "forward", kind: "caused" },
      { source: "1", target: "3", direction: "forward", kind: "caused" },
      { source: "2", target: "3", direction: "forward", kind: "caused" },
    ]);
  });

  test("renders a non-empty terminal canvas", async () => {
    const graph = buildDecisionGraph(
      [decision("1", "Root", "accepted"), decision("2", "Child", "executed", ["1"])],
      "Topic",
    );
    const canvas = await layoutDecisionGraph(graph);
    expect(canvas.lines.join("\n")).toContain("#1 Root");
    expect(canvas.lines.join("\n")).toContain("#2 Child");
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
  });

  test("renders a standalone SVG from the same layout", async () => {
    const graph = buildDecisionGraph(
      [decision("1", "Root", "accepted"), decision("2", "Child", "executed", ["1"])],
      "Topic",
    );
    const rendered = await renderDecisionGraph(graph);
    expect(rendered.svg).toStartWith("<svg");
    expect(rendered.svg).toContain("#1 Root");
    expect(rendered.svg).toContain("#2 Child");
    expect(rendered.canvas.lines.join("\n")).toContain("#2 Child");
  });

  test("keeps the complete rationale for renderer-managed wrapping", () => {
    const reasoning = `A ${"long ".repeat(30)}rationale`.trim();
    const graph = buildDecisionGraph(
      [{ ...decision("1", "Root", "accepted"), reasoning }],
      "Topic",
    );

    expect(graph.nodes[0]?.detail).toContain(reasoning);
    expect(graph.nodes[0]?.detail).not.toContain("...");
  });

  test("threads unconnected decisions onto a chronological spine", () => {
    // None of these reference each other via causedBy, so without a
    // connecting edge they'd form disconnected components that Orchgraph's
    // layered algorithm can reorder arbitrarily.
    const graph = buildDecisionGraph(
      [
        decision("1", "Alpha", "accepted"),
        decision("2", "Bravo", "accepted"),
        decision("3", "Charlie", "accepted"),
      ],
      "Topic",
    );
    expect(
      graph.edges.map(({ source, target, kind, direction, style }) => ({
        source,
        target,
        kind,
        direction,
        style,
      })),
    ).toEqual([
      { source: "1", target: "2", kind: "sequence", direction: "none", style: "dashed" },
      { source: "2", target: "3", kind: "sequence", direction: "none", style: "dashed" },
    ]);
  });

  test("skips the sequence edge when a causal path already links two decisions", () => {
    const graph = buildDecisionGraph(
      [decision("1", "Root", "accepted"), decision("2", "Child", "executed", ["1"])],
      "Topic",
    );
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: "1", target: "2", kind: "caused" });
  });

  test("does not add a sequence edge inside an already-connected component", () => {
    // #4 only causes/is-caused-by #1, but #1 already ties it to #2 and #3
    // through the union-find component, so the #3 -> #4 adjacency shouldn't
    // get a synthetic edge that would distort the causal layering.
    const graph = buildDecisionGraph(
      [
        decision("1", "Root", "accepted"),
        decision("2", "Branch A", "accepted", ["1"]),
        decision("3", "Branch B", "accepted", ["1"]),
        decision("4", "Branch C", "accepted", ["1"]),
      ],
      "Topic",
    );
    expect(graph.edges.filter((edge) => edge.kind === "sequence")).toHaveLength(0);
  });

  test("clamps spacing controls", () => {
    expect(adjustDecisionGraphSpacing(MIN_DECISION_GRAPH_SPACING, -1)).toBe(
      MIN_DECISION_GRAPH_SPACING,
    );
    expect(adjustDecisionGraphSpacing(MAX_DECISION_GRAPH_SPACING, 1)).toBe(
      MAX_DECISION_GRAPH_SPACING,
    );
  });
});
