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
const SHELL_SUMMARY_MAX_PARTS = 3;

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

function unwrapShellCommand(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+(.+)$/i);
  if (!match?.[1]) return normalized;
  const payload = match[1].trim();
  const quote = payload[0];
  return (quote === '"' || quote === "'") && payload.at(-1) === quote
    ? payload.slice(1, -1).trim()
    : payload;
}

function splitShellCommands(value: string): string[] {
  const commands: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const flush = () => {
    const command = current.trim();
    if (command) commands.push(command);
    current = "";
  };

  for (let i = 0; i < value.length; i++) {
    const char = value[i] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const pair = value.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      flush();
      i += 1;
      continue;
    }
    if (char === ";") {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return commands;
}

function shellWords(value: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const flush = () => {
    if (current) words.push(current);
    current = "";
  };

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return words;
}

function commandName(value: string): string {
  return value.replace(/\\/g, "/").split("/").at(-1) || value;
}

function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").at(-1) || normalized;
}

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    /^\.?[A-Za-z0-9_-]+\.(?:[A-Za-z0-9_-]+)$/.test(value) ||
    /^(?:CLAUDE|AGENTS|README|STYLE)(?:\.[A-Za-z0-9_-]+)?$/i.test(value)
  );
}

function summarizeTargets(values: string[]): string {
  const targets = values.filter((value) => value && !value.startsWith("-")).map(compactPath);
  if (targets.length === 0) return "";
  if (targets.length === 1) return targets[0] ?? "";
  return `${targets[0]} +${targets.length - 1}`;
}

function summarizeShellPart(value: string): string {
  const words = shellWords(value).filter((word) => !/^\d*>/.test(word));
  while (words[0] === "sudo") words.shift();
  if (words[0] === "env") {
    words.shift();
    while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0].startsWith("-"))) {
      words.shift();
    }
  }
  const executable = commandName(words.shift() ?? "");
  if (!executable || executable === "true" || executable === "printf" || executable === "echo") {
    return "";
  }

  if (executable === "pwd") return "pwd";
  if (executable === "command" && words[0] === "-v") {
    return words[1] ? `find ${commandName(words[1])}` : "find command";
  }
  if (executable === "git") {
    while (words[0]?.startsWith("-")) {
      const option = words.shift();
      if (
        option === "-C" ||
        option === "-c" ||
        option === "--git-dir" ||
        option === "--work-tree"
      ) {
        words.shift();
      }
    }
    const operation = words.shift();
    const targets = words.filter((word) => looksLikePath(word));
    const target = summarizeTargets(targets);
    return ["git", operation, target].filter(Boolean).join(" ");
  }
  if (executable === "sed") {
    const target = summarizeTargets(words.filter(looksLikePath));
    return target ? `sed ${target}` : "sed";
  }
  if (executable === "rg") {
    const filesOnly = words.includes("--files");
    const values = words.filter((word) => !word.startsWith("-"));
    const target = summarizeTargets(values);
    return filesOnly ? ["rg files", target].filter(Boolean).join(" ") : `rg ${target || "search"}`;
  }
  if (
    executable === "bun" ||
    executable === "npm" ||
    executable === "pnpm" ||
    executable === "yarn"
  ) {
    const operation = words[0];
    if (operation === "test") {
      const targets = words.slice(1).filter((word) => !word.startsWith("-"));
      return targets.length > 0
        ? `${executable} test ${targets.length} files`
        : `${executable} test`;
    }
    return [executable, operation].filter(Boolean).join(" ");
  }
  if (executable === "ls" || executable === "cat" || executable === "node") {
    const target = summarizeTargets(words.filter(looksLikePath));
    return [executable, target].filter(Boolean).join(" ");
  }

  const detail = words.find((word) => !word.startsWith("-"));
  return [executable, detail ? compactPath(detail) : ""].filter(Boolean).join(" ");
}

/** Convert a raw Codex/Claude shell invocation into a bounded display label. */
export function summarizeShellCommand(value: string): string {
  const payload = unwrapShellCommand(value);
  const parts = splitShellCommands(payload).map(summarizeShellPart).filter(Boolean);
  if (parts.length === 0) return summarizeDisplayText(payload);
  const visible = parts.slice(0, SHELL_SUMMARY_MAX_PARTS);
  const remainder = parts.length - visible.length;
  return summarizeDisplayText(`${visible.join(" · ")}${remainder > 0 ? ` · +${remainder}` : ""}`);
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
  const shortName = name.split("__").at(-1)?.toLowerCase() ?? name.toLowerCase();

  if (name === "AskUserQuestion") {
    const question = summarizePrimitive(input.question);
    if (typeof question === "string") summary.question = question;
    const choices = summarizeAskChoices(input.choices);
    if (choices) summary.choices = choices;
    return Object.keys(summary).length > 0 ? summary : undefined;
  }

  for (const key of SUMMARY_KEYS) {
    const raw = input[key];
    const value =
      (key === "command" || key === "cmd") && typeof raw === "string"
        ? summarizeShellCommand(raw)
        : summarizePrimitive(raw);
    if (value !== undefined) summary[key] = value;
  }

  if (shortName === "edit") {
    const before = summarizePrimitive(input.old_string);
    const after = summarizePrimitive(input.new_string);
    if (typeof before === "string") summary.before = before;
    if (typeof after === "string") summary.after = after;
  }
  if (shortName === "write") {
    const content = typeof input.content === "string" ? input.content : undefined;
    const preview = summarizePrimitive(content);
    if (typeof preview === "string") summary.preview = preview;
    if (content !== undefined) summary.lines = content.split("\n").length;
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
  } else if (input.command || input.cmd) {
    detail = summarizeShellCommand(String(input.command || input.cmd));
  } else if (input.file_path || input.path) detail = String(input.file_path || input.path);
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
