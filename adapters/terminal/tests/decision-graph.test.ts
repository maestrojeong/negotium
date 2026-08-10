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

  test("clamps spacing controls", () => {
    expect(adjustDecisionGraphSpacing(MIN_DECISION_GRAPH_SPACING, -1)).toBe(
      MIN_DECISION_GRAPH_SPACING,
    );
    expect(adjustDecisionGraphSpacing(MAX_DECISION_GRAPH_SPACING, 1)).toBe(
      MAX_DECISION_GRAPH_SPACING,
    );
  });
});
