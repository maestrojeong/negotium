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
/**
 * Decision cards only need a short action title plus a trimmed rationale, so
 * a narrower cap than Orchgraph's 48-column default keeps graphs with a
 * handful of nodes from sprawling well past a typical terminal width.
 */
const DECISION_NODE_MAX_WIDTH = 30;

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

/**
 * Finds chronologically adjacent decisions that sit in different causally
 * connected components, so they'd otherwise render as disconnected pieces of
 * the graph. ELK's layered algorithm does not reliably keep disconnected
 * components in input order (each isolated component can be resequenced by
 * its crossing-minimization heuristic), so without a connecting edge the
 * graph can render decisions out of chronological order. A thin "sequence"
 * edge threads each new component onto the existing spine, keeping the
 * layout roughly time-ordered top-to-bottom without implying causation.
 * Decisions already linked by any causal path (in either direction) are left
 * alone so their existing rank order isn't distorted.
 */
function chronologicalSequenceEdges(ordered: DecisionSnapshot[]): GraphEdge[] {
  const parent = new Map<string, string>();
  for (const decision of ordered) parent.set(decision.id, decision.id);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      const next = parent.get(root);
      if (next === undefined) break;
      root = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };
  for (const decision of ordered) {
    for (const upstream of decision.causedBy ?? []) {
      if (parent.has(upstream)) union(upstream, decision.id);
    }
  }

  const edges: GraphEdge[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    if (find(previous.id) === find(current.id)) continue;
    union(previous.id, current.id);
    edges.push({
      id: `sequence:${previous.id}:${current.id}`,
      source: previous.id,
      target: current.id,
      kind: "sequence",
      direction: "none",
      style: "dashed",
    });
  }
  return edges;
}

export function buildDecisionGraph(
  decisions: DecisionSnapshot[],
  topicTitle: string,
): DecisionGraph {
  const ids = new Set(decisions.map((decision) => decision.id));
  const ordered = [...decisions].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.id.localeCompare(b.id),
  );
  return {
    id: "decisions",
    title: topicTitle,
    direction: "DOWN",
    nodes: ordered.map((decision) => ({
      id: decision.id,
      label: `#${decision.id} ${decision.action}`,
      detail: compactDetail(decision),
      kind: decision.status,
      state: decisionNodeState(decision.status),
      metadata: { timestamp: decision.timestamp, agent: decision.agent, model: decision.model },
    })),
    edges: [
      ...ordered.flatMap((decision) =>
        (decision.causedBy ?? [])
          .filter((upstream) => ids.has(upstream))
          .map((upstream) => ({
            id: `caused:${upstream}:${decision.id}`,
            source: upstream,
            target: decision.id,
            kind: "caused",
            direction: "forward" as const,
            style: "solid" as const,
          })),
      ),
      ...chronologicalSequenceEdges(ordered),
    ],
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
    maxNodeWidth: DECISION_NODE_MAX_WIDTH,
  });
  return {
    canvas: { ...renderTerminalGraph(graph, geometry), title: graph.title },
    svg: renderSvgGraph(graph, geometry, { title: graph.title }),
  };
}
