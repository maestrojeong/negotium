import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { TopicDto } from "@negotium/core";
import type { SubagentGraphCanvas } from "@/state";
import { displayWidth } from "@/terminal-width";

export const DEFAULT_SUBAGENT_GRAPH_SPACING = 4;
export const MIN_SUBAGENT_GRAPH_SPACING = 2;
export const MAX_SUBAGENT_GRAPH_SPACING = 10;

export function adjustSubagentGraphSpacing(current: number, delta: number): number {
  return Math.min(
    MAX_SUBAGENT_GRAPH_SPACING,
    Math.max(MIN_SUBAGENT_GRAPH_SPACING, current + delta),
  );
}

function terminalGraphLayout(spacing: number) {
  const normalized = adjustSubagentGraphSpacing(spacing, 0);
  return {
    padding: Math.max(1, Math.round(normalized / 4)),
    nodeSpacing: normalized,
    layerSpacing: Math.max(2, Math.round(normalized * 0.75)),
    edgeNodeSpacing: Math.max(1, Math.round(normalized / 2)),
    edgeEdgeSpacing: Math.max(1, Math.round(normalized / 2)),
  };
}

const ELK_HOST_SOURCE = `
const modulePath = process.argv[1];
const imported = require(modulePath);
const ELK = imported.default || imported;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", async () => {
  try {
    const result = await new ELK().layout(JSON.parse(input));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
});
`;

interface GraphNode {
  id: string;
  title: string;
  detail: string;
  running: boolean;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "owns" | "owns-parent-only" | "tell" | "tell-bidirectional";
}

export interface SubagentGraph {
  rootTitle: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface ElkPoint {
  x: number;
  y: number;
}

interface ElkSection {
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
}

interface ElkNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ElkEdge {
  id: string;
  sections?: ElkSection[];
}

interface ElkResult {
  width?: number;
  height?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
}

function textWidth(value: string): number {
  return displayWidth(value);
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
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (kind: GraphEdge["kind"], source: string, target: string): void => {
    if (!scopedIds.has(source) || !scopedIds.has(target) || source === target) return;
    if (kind === "tell") {
      const reverseIndex = edges.findIndex(
        (edge) =>
          (edge.kind === "tell" || edge.kind === "tell-bidirectional") &&
          edge.source === target &&
          edge.target === source,
      );
      if (reverseIndex >= 0) {
        const reverse = edges[reverseIndex]!;
        if (reverse.kind === "tell") {
          edgeKeys.delete(reverse.id);
          const id = `tell-bidirectional:${reverse.source}:${reverse.target}`;
          edges[reverseIndex] = { ...reverse, id, kind: "tell-bidirectional" };
          edgeKeys.add(id);
        }
        return;
      }
    }
    const key = `${kind}:${source}:${target}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: key, source, target, kind });
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

  return {
    rootTitle: scoped[0]?.title ?? activeTopicId,
    nodes: scoped.map((topic) => ({
      id: topic.id,
      title: topic.title.trim() || topic.id,
      detail: `${topic.agent ?? "agent"} · ${topic.effectiveModel ?? topic.defaultModel ?? "default"} · ${topic.effectiveEffort ?? topic.defaultEffort ?? "default"}`,
      running: runningTopicIds.has(topic.id),
    })),
    edges,
  };
}

function layoutInput(graph: SubagentGraph, spacing: number): object {
  const layout = terminalGraphLayout(spacing);
  return {
    id: "subagents",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": `[top=${layout.padding},left=${layout.padding},bottom=${layout.padding},right=${layout.padding}]`,
      "elk.spacing.nodeNode": String(layout.nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layout.layerSpacing),
      "elk.layered.spacing.edgeNodeBetweenLayers": String(layout.edgeNodeSpacing),
      "elk.layered.spacing.edgeEdgeBetweenLayers": String(layout.edgeEdgeSpacing),
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: graph.nodes.map((node) => {
      const contentWidth = Math.max(textWidth(node.title) + 4, textWidth(node.detail) + 2, 12);
      return { id: node.id, width: contentWidth + 2, height: 4 };
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
}

export const MAX_ELK_OUTPUT_BYTES = 1024 * 1024;

export function appendElkOutput(
  current: string,
  chunk: string,
  maxBytes = MAX_ELK_OUTPUT_BYTES,
): string {
  if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > maxBytes) {
    throw new Error(`ELK output exceeded ${maxBytes} bytes`);
  }
  return current + chunk;
}

async function runElk(input: object, signal?: AbortSignal): Promise<ElkResult> {
  const require = createRequire(import.meta.url);
  const elkPath = require.resolve("elkjs/lib/elk.bundled.js");
  const nodeBinary = process.env.NEGOTIUM_NODE_BINARY?.trim() || "node";

  return await new Promise<ElkResult>((resolve, reject) => {
    const child = spawn(nodeBinary, ["--eval", ELK_HOST_SOURCE, elkPath], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendElkOutput(stdout, chunk);
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendElkOutput(stderr, chunk);
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error("Node.js 20+ is required for the agent graph (Ctrl-G)")
          : error,
      );
    });
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `ELK exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ElkResult);
      } catch {
        reject(new Error("ELK returned an invalid layout"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function rounded(value: number | undefined): number {
  return Math.max(0, Math.round(value ?? 0));
}

function edgeCharacter(existing: string, next: "horizontal" | "vertical", tell: boolean): string {
  const glyph = tell ? (next === "horizontal" ? "┈" : "┊") : next === "horizontal" ? "─" : "│";
  if (existing === " " || existing === glyph) return glyph;
  if ("─┈".includes(existing) && next === "horizontal") return existing;
  if ("│┊".includes(existing) && next === "vertical") return existing;
  return "┼";
}

function edgeMidpoint(points: ElkPoint[]): ElkPoint {
  const lengths = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
  });
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    const start = points[index]!;
    const end = points[index + 1]!;
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length;
      return {
        x: Math.round(start.x + (end.x - start.x) * ratio),
        y: Math.round(start.y + (end.y - start.y) * ratio),
      };
    }
    remaining -= length;
  }
  return points.at(-1) ?? { x: 0, y: 0 };
}

function renderCanvas(graph: SubagentGraph, layout: ElkResult): SubagentGraphCanvas {
  const width = Math.max(1, rounded(layout.width) + 2);
  const height = Math.max(1, rounded(layout.height) + 2);
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const put = (x: number, y: number, value: string): void => {
    if (y < 0 || y >= height || x < 0 || x >= width) return;
    cells[y]![x] = value;
  };
  const putText = (x: number, y: number, value: string, maxWidth: number): void => {
    let column = 0;
    for (const character of [...value]) {
      const width = displayWidth(character);
      if (column + width > maxWidth) break;
      put(x + column, y, character);
      if (width === 2) put(x + column + 1, y, "");
      column += width;
    }
  };
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const edgeLabels: Array<{ x: number; y: number; text: string }> = [];
  const edges: NonNullable<SubagentGraphCanvas["edges"]> = [];

  for (const laidOutEdge of layout.edges ?? []) {
    const edge = edgeById.get(laidOutEdge.id);
    if (!edge) continue;
    const edgeCells = new Map<string, { x: number; y: number }>();
    const recordEdgeCell = (x: number, y: number): void => {
      edgeCells.set(`${x}:${y}`, { x, y });
    };
    for (const section of laidOutEdge.sections ?? []) {
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
        (point) => ({ x: rounded(point.x) + 1, y: rounded(point.y) + 1 }),
      );
      for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1]!;
        const to = points[index]!;
        const horizontal = from.y === to.y;
        const distance = horizontal ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y);
        const xStep = horizontal ? Math.sign(to.x - from.x) : 0;
        const yStep = horizontal ? 0 : Math.sign(to.y - from.y);
        for (let offset = 0; offset <= distance; offset += 1) {
          const x = from.x + xStep * offset;
          const y = from.y + yStep * offset;
          const existing = cells[y]?.[x] ?? " ";
          put(
            x,
            y,
            edgeCharacter(
              existing,
              horizontal ? "horizontal" : "vertical",
              edge.kind === "tell" || edge.kind === "tell-bidirectional",
            ),
          );
          recordEdgeCell(x, y);
        }
      }
      const end = points.at(-1);
      const before = points.at(-2);
      if (end && before) {
        const arrowX = end.x - Math.sign(end.x - before.x);
        const arrowY = end.y - Math.sign(end.y - before.y);
        const arrow =
          end.y > before.y ? "▼" : end.y < before.y ? "▲" : end.x > before.x ? "▶" : "◀";
        put(arrowX, arrowY, arrow);
        recordEdgeCell(arrowX, arrowY);
      }
      if (edge.kind === "owns" || edge.kind === "tell-bidirectional") {
        const start = points[0];
        const after = points[1];
        if (start && after) {
          const arrowX = start.x + Math.sign(after.x - start.x);
          const arrowY = start.y + Math.sign(after.y - start.y);
          const arrow =
            after.y > start.y ? "▲" : after.y < start.y ? "▼" : after.x > start.x ? "◀" : "▶";
          put(arrowX, arrowY, arrow);
          recordEdgeCell(arrowX, arrowY);
        }
      }
      if (
        (edge.kind === "owns-parent-only" ||
          edge.kind === "tell" ||
          edge.kind === "tell-bidirectional") &&
        points.length > 1
      ) {
        const middle = edgeMidpoint(points);
        const label =
          edge.kind === "owns-parent-only"
            ? " status only ↓ "
            : edge.kind === "tell-bidirectional"
              ? " tell ↔ "
              : " tell ";
        edgeLabels.push({
          x: middle.x - Math.floor(label.length / 2),
          y: middle.y,
          text: label,
        });
      }
    }
    edges.push({
      sourceTopicId: edge.source,
      targetTopicId: edge.target,
      kind: edge.kind,
      cells: [...edgeCells.values()],
    });
  }

  for (const label of edgeLabels) putText(label.x, label.y, label.text, textWidth(label.text));

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes: NonNullable<SubagentGraphCanvas["nodes"]> = [];
  for (const laidOutNode of layout.children ?? []) {
    const node = nodeById.get(laidOutNode.id);
    if (!node) continue;
    const x = rounded(laidOutNode.x) + 1;
    const y = rounded(laidOutNode.y) + 1;
    const nodeWidth = Math.max(4, rounded(laidOutNode.width));
    const nodeHeight = Math.max(4, rounded(laidOutNode.height));
    for (let row = 0; row < nodeHeight; row += 1) {
      for (let column = 0; column < nodeWidth; column += 1) put(x + column, y + row, " ");
    }
    put(x, y, "╭");
    put(x + nodeWidth - 1, y, "╮");
    put(x, y + nodeHeight - 1, "╰");
    put(x + nodeWidth - 1, y + nodeHeight - 1, "╯");
    for (let column = 1; column < nodeWidth - 1; column += 1) {
      put(x + column, y, "─");
      put(x + column, y + nodeHeight - 1, "─");
    }
    for (let row = 1; row < nodeHeight - 1; row += 1) {
      put(x, y + row, "│");
      put(x + nodeWidth - 1, y + row, "│");
    }
    putText(x + 2, y + 1, `${node.running ? "●" : "○"} ${node.title}`, nodeWidth - 3);
    putText(x + 2, y + 2, node.detail, nodeWidth - 3);
    nodes.push({
      topicId: node.id,
      title: node.title,
      markerX: x + 2,
      markerY: y + 1,
    });
  }

  return {
    title: graph.rootTitle,
    rootDetail: graph.nodes[0]?.detail,
    rootRunning: graph.nodes[0]?.running,
    nodes,
    edges,
    lines: cells.map((row) => row.join("").trimEnd()),
    width,
    height,
  };
}

export async function layoutSubagentGraph(
  graph: SubagentGraph,
  spacing = DEFAULT_SUBAGENT_GRAPH_SPACING,
  signal?: AbortSignal,
): Promise<SubagentGraphCanvas> {
  if (graph.nodes.length === 0) {
    return { title: graph.rootTitle, lines: [], width: 0, height: 0 };
  }
  return renderCanvas(graph, await runElk(layoutInput(graph, spacing), signal));
}
