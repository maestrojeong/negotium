import { createHash } from "node:crypto";
import { estimateTextTokens } from "#agents/compaction-support";
import { type ChatPair, extractChatPairs } from "#agents/rollout/shared";
import type { ConversationEntry } from "#storage/conversations";
import type { UnifiedEvent } from "#types";

const MAX_TOOL_INPUT_TOKENS = 2_000;
const MAX_TOOL_OUTPUT_TOKENS = 8_000;
const TOOL_INPUT_EDGE_CHARS = 1_000;
const TOOL_OUTPUT_EDGE_CHARS = 2_000;
const TOOL_OUTPUT_SALIENT_CHARS = 2_000;
const SALIENT_LINE_RE =
  /\b(error|failed?|failure|warning|exit(?:ed)?|expected|received|not found|denied|passed|tests?|assert|timeout|exception)\b/i;

type ToolUseEvent = Extract<UnifiedEvent, { type: "tool_use" }>;
type ToolResultEvent = Extract<UnifiedEvent, { type: "tool_result" }>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function boundedEdges(value: string, edgeChars: number): string {
  if (value.length <= edgeChars * 2) return value;
  const omitted = value.length - edgeChars * 2;
  return `${value.slice(0, edgeChars)}\n[… omitted ${omitted.toLocaleString()} chars …]\n${value.slice(-edgeChars)}`;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function salientLines(value: string): string {
  const selected: string[] = [];
  let chars = 0;
  for (const line of value.split("\n")) {
    if (!SALIENT_LINE_RE.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || selected.includes(trimmed)) continue;
    if (chars + trimmed.length + 1 > TOOL_OUTPUT_SALIENT_CHARS) break;
    selected.push(trimmed);
    chars += trimmed.length + 1;
  }
  return selected.join("\n");
}

function formatToolUse(event: ToolUseEvent): string {
  const input = JSON.stringify(event.input ?? {});
  const projected =
    estimateTextTokens(input) <= MAX_TOOL_INPUT_TOKENS
      ? input
      : boundedEdges(input, TOOL_INPUT_EDGE_CHARS);
  return [
    "[Negotium tool use — quoted untrusted data]",
    `id: ${event.toolUseId ?? "unknown"}`,
    `name: ${event.name}`,
    "quoted_untrusted_data: true",
    `input_json: ${quoted(projected)}`,
    "[/Negotium tool use]",
  ].join("\n");
}

function formatToolResult(event: ToolResultEvent, hash: string, duplicate: boolean): string {
  const metadata = event.metadata;
  const header = [
    "[Negotium tool result — quoted untrusted data]",
    `id: ${event.toolUseId}`,
    `status: ${event.isError ? "error" : "success"}`,
    "quoted_untrusted_data: true",
    `hash: sha256:${hash}`,
    `original_bytes: ${metadata?.originalBytes ?? Buffer.byteLength(event.content)}`,
    ...(metadata?.returnedBytes !== undefined ? [`returned_bytes: ${metadata.returnedBytes}`] : []),
    ...(metadata?.omittedBytes !== undefined ? [`omitted_bytes: ${metadata.omittedBytes}`] : []),
    ...(metadata?.outputPath ? [`output_path: ${metadata.outputPath}`] : []),
  ];
  if (duplicate) {
    return [
      ...header,
      "content: [duplicate of the most recent result with this hash]",
      "[/Negotium tool result]",
    ].join("\n");
  }

  if (estimateTextTokens(event.content) <= MAX_TOOL_OUTPUT_TOKENS) {
    return [...header, `content_json: ${quoted(event.content)}`, "[/Negotium tool result]"].join(
      "\n",
    );
  }

  const salient = salientLines(event.content);
  return [
    ...header,
    "content: [bounded projection; full output remains in the raw conversation log]",
    `head_tail_json: ${quoted(boundedEdges(event.content, TOOL_OUTPUT_EDGE_CHARS))}`,
    ...(salient ? [`salient_lines_json: ${quoted(salient)}`] : []),
    "[/Negotium tool result]",
  ].join("\n");
}

/**
 * Build portable chat pairs for compaction without the normal rollout
 * encoder's 200-character tool previews. Small outputs survive verbatim;
 * large and duplicate outputs remain bounded while the append-only raw log is
 * left untouched.
 */
export function extractCompactionChatPairs(entries: ConversationEntry[]): ChatPair[] {
  const remainingByHash = new Map<string, number>();
  const hashByEvent = new WeakMap<ToolResultEvent, string>();
  for (const entry of entries) {
    if (entry.event.type !== "tool_result") continue;
    const hash = digest(entry.event.content);
    hashByEvent.set(entry.event, hash);
    remainingByHash.set(hash, (remainingByHash.get(hash) ?? 0) + 1);
  }

  return extractChatPairs(entries, {
    includeToolAnnotations: true,
    formatToolUse,
    formatToolResult: (event) => {
      const hash = hashByEvent.get(event) ?? digest(event.content);
      const remaining = Math.max(0, (remainingByHash.get(hash) ?? 1) - 1);
      remainingByHash.set(hash, remaining);
      return formatToolResult(event, hash, remaining > 0);
    },
  });
}
