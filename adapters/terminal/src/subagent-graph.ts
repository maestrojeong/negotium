import type { TopicDto } from "@negotium/core";
import {
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  layoutTerminalGraph,
  type NodeState,
  renderTerminalCanvas,
  type TerminalCanvas,
} from "orchgraph";
import type { SubagentGraphCanvas, SubagentGraphEdgeKind } from "@/state";

export const DEFAULT_SUBAGENT_GRAPH_SPACING = 4;
export const MIN_SUBAGENT_GRAPH_SPACING = 2;
export const MAX_SUBAGENT_GRAPH_SPACING = 10;

interface SubagentGraphNode extends GraphNode {
  detail: string;
}

interface SubagentGraphEdge extends GraphEdge {
  id: string;
  kind: SubagentGraphEdgeKind;
}

export interface SubagentGraph extends GraphDocument {
  title: string;
  nodes: SubagentGraphNode[];
  edges: SubagentGraphEdge[];
  rootDetail?: string;
  rootRunning?: boolean;
}

export function adjustSubagentGraphSpacing(current: number, delta: number): number {
  return Math.min(
    MAX_SUBAGENT_GRAPH_SPACING,
    Math.max(MIN_SUBAGENT_GRAPH_SPACING, current + delta),
  );
}

function isSubagentGraphEdgeKind(value: string | undefined): value is SubagentGraphEdgeKind {
  return (
    value === "owns" ||
    value === "owns-parent-only" ||
    value === "tell" ||
    value === "tell-bidirectional"
  );
}

function scopedTopics(topics: TopicDto[], activeTopicId: string): TopicDto[] {
  const root = topics.find((topic) => topic.id === activeTopicId);
  if (!root) return [];

  const childrenByParent = new Map<string, TopicDto[]>();
  for (const topic of topics) {
    if (!topic.isSubagent || !topic.parentTopicId || topic.parentTopicId === topic.id) continue;
    const children = childrenByParent.get(topic.parentTopicId) ?? [];
    children.push(topic);
    childrenByParent.set(topic.parentTopicId, children);
  }

  const scoped: TopicDto[] = [];
  const visited = new Set<string>();
  const append = (topic: TopicDto): void => {
    if (visited.has(topic.id)) return;
    visited.add(topic.id);
    scoped.push(topic);
    for (const child of childrenByParent.get(topic.id) ?? []) append(child);
  };
  append(root);
  return scoped;
}

function edgePresentation(
  kind: SubagentGraphEdgeKind,
): Pick<SubagentGraphEdge, "direction" | "style" | "label"> {
  switch (kind) {
    case "owns":
      return { direction: "both", style: "solid" };
    case "owns-parent-only":
      return { direction: "forward", style: "solid", label: "status only ↓" };
    case "tell":
      return { direction: "forward", style: "dashed", label: "tell" };
    case "tell-bidirectional":
      return { direction: "both", style: "dashed", label: "tell ↔" };
  }
}

export function buildSubagentGraph(
  topics: TopicDto[],
  activeTopicId: string,
  runningTopicIds: ReadonlySet<string> = new Set(),
): SubagentGraph {
  const scoped = scopedTopics(topics, activeTopicId);
  const scopedIds = new Set(scoped.map((topic) => topic.id));
  for (const topic of topics) {
    const connectsFromScope =
      scopedIds.has(topic.id) &&
      (topic.subagentTellTargetIds ?? []).some((targetId) => !scopedIds.has(targetId));
    const connectsIntoScope =
      !scopedIds.has(topic.id) &&
      (topic.subagentTellTargetIds ?? []).some((targetId) => scopedIds.has(targetId));
    if (!connectsFromScope && !connectsIntoScope) continue;
    if (!scopedIds.has(topic.id)) {
      scoped.push(topic);
      scopedIds.add(topic.id);
    }
    for (const targetId of topic.subagentTellTargetIds ?? []) {
      if (scopedIds.has(targetId)) continue;
      const target = topics.find((candidate) => candidate.id === targetId);
      if (!target) continue;
      scoped.push(target);
      scopedIds.add(target.id);
    }
  }

  const domainEdges: Array<{
    id: string;
    source: string;
    target: string;
    kind: SubagentGraphEdgeKind;
  }> = [];
  const edgeKeys = new Set<string>();
  const addEdge = (kind: SubagentGraphEdgeKind, source: string, target: string): void => {
    if (!scopedIds.has(source) || !scopedIds.has(target) || source === target) return;
    if (kind === "tell") {
      const reverseIndex = domainEdges.findIndex(
        (edge) =>
          (edge.kind === "tell" || edge.kind === "tell-bidirectional") &&
          edge.source === target &&
          edge.target === source,
      );
      if (reverseIndex >= 0) {
        const reverse = domainEdges[reverseIndex];
        if (reverse?.kind === "tell") {
          edgeKeys.delete(reverse.id);
          const id = `tell-bidirectional:${reverse.source}:${reverse.target}`;
          domainEdges[reverseIndex] = { ...reverse, id, kind: "tell-bidirectional" };
          edgeKeys.add(id);
        }
        return;
      }
    }
    const id = `${kind}:${source}:${target}`;
    if (edgeKeys.has(id)) return;
    edgeKeys.add(id);
    domainEdges.push({ id, source, target, kind });
  };

  for (const topic of scoped) {
    if (topic.id !== activeTopicId && topic.parentTopicId) {
      addEdge(
        topic.subagentReportMode === "status-only" ? "owns-parent-only" : "owns",
        topic.parentTopicId,
        topic.id,
      );
    }
    for (const targetId of topic.subagentTellTargetIds ?? []) {
      addEdge("tell", topic.id, targetId);
    }
  }

  const nodes: SubagentGraphNode[] = scoped.map((topic) => ({
    id: topic.id,
    label: topic.title.trim() || topic.id,
    detail: `${topic.agent ?? "agent"} · ${topic.effectiveModel ?? topic.defaultModel ?? "default"} · ${topic.effectiveEffort ?? topic.defaultEffort ?? "default"}`,
    state: runningTopicIds.has(topic.id) ? "running" : "idle",
  }));
  const root = nodes[0];

  return {
    id: "subagents",
    title: root?.label ?? activeTopicId,
    direction: "DOWN",
    nodes,
    edges: domainEdges.map((edge) => ({ ...edge, ...edgePresentation(edge.kind) })),
    rootDetail: root?.detail,
    rootRunning: root?.state === "running",
  };
}

/**
 * Structural identity of a graph for a given spacing — everything that affects
 * ELK layout, but NOT the per-node running state. When this is unchanged, live
 * agent-state updates can be re-rendered from a cached canvas without rerunning
 * layout (see `applySubagentGraphStates`).
 */
export function subagentGraphSignature(graph: SubagentGraph, spacing: number): string {
  return JSON.stringify({
    spacing,
    direction: graph.direction,
    title: graph.title,
    rootDetail: graph.rootDetail,
    nodes: graph.nodes.map((node) => [node.id, node.label, node.detail]),
    edges: graph.edges.map((edge) => [
      edge.id,
      edge.source,
      edge.target,
      edge.kind,
      edge.direction,
      edge.style,
      edge.label,
    ]),
  });
}

/**
 * Re-render a laid-out canvas with a fresh running-state overlay. This never
 * recomputes layout (orchgraph 0.2.0 `nodeStates`), so it is the cheap path for
 * live agent-state changes when the graph structure is unchanged.
 */
export function applySubagentGraphStates(
  canvas: SubagentGraphCanvas,
  runningTopicIds: ReadonlySet<string>,
): SubagentGraphCanvas {
  const nodeStates: Record<string, NodeState> = {};
  for (const node of canvas.nodes) {
    nodeStates[node.id] = runningTopicIds.has(node.id) ? "running" : "idle";
  }
  const lines = renderTerminalCanvas(canvas as unknown as TerminalCanvas, { nodeStates });
  const rootId = canvas.nodes[0]?.id;
  return {
    ...canvas,
    lines,
    rootRunning: rootId ? runningTopicIds.has(rootId) : canvas.rootRunning,
  };
}

export async function layoutSubagentGraph(
  graph: SubagentGraph,
  spacing = DEFAULT_SUBAGENT_GRAPH_SPACING,
  signal?: AbortSignal,
): Promise<SubagentGraphCanvas> {
  const canvas = await layoutTerminalGraph(graph, {
    direction: "DOWN",
    spacing,
    signal,
    timeoutMs: 15_000,
  });
  return {
    ...canvas,
    title: graph.title,
    rootDetail: graph.rootDetail,
    rootRunning: graph.rootRunning,
    edges: canvas.edges.map(({ kind, ...edge }) =>
      isSubagentGraphEdgeKind(kind) ? { ...edge, kind } : edge,
    ),
  };
}
