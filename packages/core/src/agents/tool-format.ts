/**
 * Format a tool_use event into a human-readable label.
 *
 * Agent-agnostic: the SDKs share the same convention of `(name, input record)`
 * for tool calls, so this lives next to the providers rather than inside any
 * one of them. Used by progress messages, fork relays, and the conversation
 * event processor.
 */
export type ToolCallSummaryValue =
  | string
  | number
  | boolean
  | Array<{ label: string; description?: string }>;

export type ToolCallSummaryInput = Record<string, ToolCallSummaryValue>;

const TOOL_SUMMARY_MAX_CHARS = 90;
const TOOL_SUMMARY_HEAD_CHARS = 52;
const TOOL_SUMMARY_TAIL_CHARS = 28;

const SUMMARY_KEYS = [
  "command",
  "cmd",
  "file_path",
  "file_id",
  "path",
  "image_path",
  "url",
  "query",
  "pattern",
  "question",
  "task",
  "description",
  "title",
  "theme",
  "alt",
  "to",
] as const;

export function summarizeDisplayText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= TOOL_SUMMARY_MAX_CHARS) return normalized;
  return `${normalized.slice(0, TOOL_SUMMARY_HEAD_CHARS).trimEnd()}...${normalized
    .slice(-TOOL_SUMMARY_TAIL_CHARS)
    .trimStart()}`;
}

function summarizePrimitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  return summarizeDisplayText(value) || undefined;
}

function summarizeAskChoices(
  value: unknown,
): Array<{ label: string; description?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices = value
    .map((choice) => {
      if (!choice || typeof choice !== "object") return null;
      const record = choice as Record<string, unknown>;
      const label = summarizePrimitive(record.label);
      if (typeof label !== "string") return null;
      const description = summarizePrimitive(record.description);
      return {
        label,
        ...(typeof description === "string" ? { description } : {}),
      };
    })
    .filter((choice): choice is { label: string; description?: string } => choice !== null)
    .slice(0, 6);
  return choices.length > 0 ? choices : undefined;
}

export function summarizeToolInput(
  name: string,
  input: Record<string, unknown>,
): ToolCallSummaryInput | undefined {
  const summary: ToolCallSummaryInput = {};

  if (name === "AskUserQuestion") {
    const question = summarizePrimitive(input.question);
    if (typeof question === "string") summary.question = question;
    const choices = summarizeAskChoices(input.choices);
    if (choices) summary.choices = choices;
    return Object.keys(summary).length > 0 ? summary : undefined;
  }

  for (const key of SUMMARY_KEYS) {
    const value = summarizePrimitive(input[key]);
    if (value !== undefined) summary[key] = value;
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function formatToolUse(name: string, input: Record<string, unknown>): string {
  let detail = "";
  if (name === "View" && input.question) {
    const file = input.image_path || input.file_path || input.path;
    const fileName = typeof file === "string" ? file.split("/").pop() : "";
    const suffix = fileName ? ` [${fileName}]` : "";
    detail = `${String(input.question)}${suffix}`;
  } else if ((name === "Agent" || name === "Task") && input.subagent_type) {
    const type = String(input.subagent_type);
    const desc = input.description ? ` ${String(input.description).slice(0, 60)}` : "";
    detail = `[${type}]${desc}`;
  } else if (input.command) detail = String(input.command);
  else if (input.file_path || input.path) detail = String(input.file_path || input.path);
  else if (input.file_id) detail = String(input.file_id);
  else if (input.url) detail = String(input.url);
  else if (input.pattern) detail = String(input.pattern);
  else if (input.query || input.text) detail = String(input.query || input.text);
  else if (input.task) detail = String(input.task);
  else if (input.title) detail = String(input.title);
  else if (input.to) detail = String(input.to);
  else if (input.message) detail = String(input.message).slice(0, 80);
  else if (input.content) detail = String(input.content).slice(0, 80);

  if (detail) {
    return `${name}(${detail.length > 100 ? `${detail.slice(0, 100)}...` : detail})`;
  }
  return name;
}
