import type { DecisionSnapshot } from "@negotium/core";
import {
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  layoutGraph,
  type NodeState,
  renderSvgGraph,
  renderTerminalGraph,
  type TerminalCanvas,
} from "orchgraph";

export const DEFAULT_DECISION_GRAPH_SPACING = 4;
export const MIN_DECISION_GRAPH_SPACING = 2;
export const MAX_DECISION_GRAPH_SPACING = 10;

export interface DecisionGraph extends GraphDocument {
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface DecisionGraphCanvas extends TerminalCanvas {
  title: string;
}

export interface DecisionGraphRender {
  canvas: DecisionGraphCanvas;
  svg: string;
}

export function adjustDecisionGraphSpacing(current: number, delta: number): number {
  return Math.min(
    MAX_DECISION_GRAPH_SPACING,
    Math.max(MIN_DECISION_GRAPH_SPACING, current + delta),
  );
}

function decisionNodeState(status: DecisionSnapshot["status"]): NodeState {
  switch (status) {
    case "proposed":
      return "queued";
    case "executed":
      return "succeeded";
    case "rejected":
      return "failed";
    case "superseded":
      return "blocked";
    default:
      return "idle";
  }
}

function compactDetail(decision: DecisionSnapshot): string {
  const rationale = decision.reasoning.replace(/\s+/g, " ").trim();
  return `${rationale} · ${decision.agent}${decision.model ? `/${decision.model}` : ""}`;
}

export function buildDecisionGraph(
  decisions: DecisionSnapshot[],
  topicTitle: string,
): DecisionGraph {
  const ids = new Set(decisions.map((decision) => decision.id));
  return {
    id: "decisions",
    title: topicTitle,
    direction: "DOWN",
    nodes: decisions.map((decision) => ({
      id: decision.id,
      label: `#${decision.id} ${decision.action}`,
      detail: compactDetail(decision),
      kind: decision.status,
      state: decisionNodeState(decision.status),
      metadata: { timestamp: decision.timestamp, agent: decision.agent, model: decision.model },
    })),
    edges: decisions.flatMap((decision) =>
      (decision.causedBy ?? [])
        .filter((upstream) => ids.has(upstream))
        .map((upstream) => ({
          id: `caused:${upstream}:${decision.id}`,
          source: upstream,
          target: decision.id,
          label: "caused",
          kind: "caused",
          direction: "forward" as const,
          style: "solid" as const,
        })),
    ),
  };
}

export async function layoutDecisionGraph(
  graph: DecisionGraph,
  spacing = DEFAULT_DECISION_GRAPH_SPACING,
  signal?: AbortSignal,
): Promise<DecisionGraphCanvas> {
  return (await renderDecisionGraph(graph, spacing, signal)).canvas;
}

export async function renderDecisionGraph(
  graph: DecisionGraph,
  spacing = DEFAULT_DECISION_GRAPH_SPACING,
  signal?: AbortSignal,
): Promise<DecisionGraphRender> {
  const geometry = await layoutGraph(graph, {
    direction: "DOWN",
    spacing,
    signal,
    timeoutMs: 15_000,
  });
  return {
    canvas: { ...renderTerminalGraph(graph, geometry), title: graph.title },
    svg: renderSvgGraph(graph, geometry, { title: graph.title }),
  };
}
