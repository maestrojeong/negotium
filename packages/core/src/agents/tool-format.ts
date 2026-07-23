/**
 * Format a tool_use event into a human-readable label.
 *
 * Agent-agnostic: the SDKs share the same convention of `(name, input record)`
 * for tool calls, so this lives next to the providers rather than inside any
 * one of them. Used by progress messages, fork relays, and the conversation
 * event processor.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { diffLines as computeLineDiff } from "diff";

export type ToolCallSummaryValue =
  | string
  | number
  | boolean
  | Array<{ label: string; description?: string }>;

export type ToolCallSummaryInput = Record<string, ToolCallSummaryValue>;

const TOOL_SUMMARY_MAX_CHARS = 90;
const TOOL_SUMMARY_HEAD_CHARS = 52;
const TOOL_SUMMARY_TAIL_CHARS = 28;
const TOOL_DIFF_MAX_CHARS = 4_000;
const TOOL_DIFF_SOURCE_MAX_BYTES = 2_000_000;
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
  "change_kind",
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

/**
 * Give simple, demonstrably read-only shell commands a more meaningful
 * timeline name. This is shared display metadata only; every provider still
 * executes the original shell tool unchanged.
 */
export function classifyShellToolName(value: string): "Bash" | "Read" | "Search" {
  // unwrapShellCommand() normalizes whitespace for display, so reject scripts
  // with physical line breaks before that normalization can hide composition.
  if (/[\r\n]/.test(value)) return "Bash";
  const payload = unwrapShellCommand(value);
  // Composition, redirection, substitution, and multi-line scripts can turn
  // a read-only executable into a mutating command, so keep those as Bash.
  if (/[|;&><`]/.test(payload) || payload.includes("$(")) return "Bash";

  const words = shellWords(payload);
  while (words[0] === "sudo") words.shift();
  if (words[0] === "env") {
    words.shift();
    while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0].startsWith("-"))) {
      words.shift();
    }
  }
  const executable = commandName(words.shift() ?? "");
  if (
    executable === "cat" ||
    executable === "head" ||
    executable === "tail" ||
    executable === "wc"
  ) {
    return "Read";
  }
  if (executable === "sed") {
    const mutatingOption = words.some(
      (word) =>
        word === "-i" ||
        word.startsWith("-i") ||
        word === "--in-place" ||
        word.startsWith("--in-place="),
    );
    const scriptWrites = words.some(
      (word) =>
        /(?:^|[;}\n])\s*(?:w|W|e)\b/.test(word) ||
        /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpimsxyM]*w\b/.test(word),
    );
    if (!mutatingOption && !scriptWrites) return "Read";
  }
  if (executable === "rg" || executable === "grep" || executable === "ls") return "Search";
  if (
    executable === "find" &&
    !words.some((word) =>
      [
        "-delete",
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-fprint",
        "-fprint0",
        "-fprintf",
        "-fls",
      ].includes(word),
    )
  ) {
    return "Search";
  }
  return "Bash";
}

function summarizePrimitive(value: unknown): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  return summarizeDisplayText(value) || undefined;
}

function summarizeDiffText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return undefined;
  if (normalized.length <= TOOL_DIFF_MAX_CHARS) return normalized;
  return `${normalized.slice(0, TOOL_DIFF_MAX_CHARS - 2)}\n…`;
}

function changedDiffLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export interface NumberedDiffSummary {
  before?: string;
  after?: string;
  diffPreview?: string;
}

/** Build one Git-style numbered diff used by every provider and adapter. */
export function buildNumberedDiffSummary(
  before: string,
  after: string,
  startLine = 1,
): NumberedDiffSummary {
  const removed: string[] = [];
  const added: string[] = [];
  const preview: string[] = [];
  let oldLine = startLine;
  let newLine = startLine;
  for (const part of computeLineDiff(before, after)) {
    const lines = changedDiffLines(part.value);
    if (part.removed) {
      for (const line of lines) {
        removed.push(line);
        preview.push(`${oldLine} -${line}`);
        oldLine += 1;
      }
      continue;
    }
    if (part.added) {
      for (const line of lines) {
        added.push(line);
        preview.push(`${newLine} +${line}`);
        newLine += 1;
      }
      continue;
    }
    oldLine += lines.length;
    newLine += lines.length;
  }
  return {
    ...(removed.length > 0 ? { before: removed.join("\n") } : {}),
    ...(added.length > 0 ? { after: added.join("\n") } : {}),
    ...(preview.length > 0 ? { diffPreview: preview.join("\n") } : {}),
  };
}

function sourceStartLine(
  input: Record<string, unknown>,
  before: string,
  after: string,
  cwd: string | undefined,
): number {
  const rawPath = input.file_path ?? input.path;
  if (typeof rawPath !== "string" || !rawPath.trim()) return 1;
  const path = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath);
  try {
    if (statSync(path).size > TOOL_DIFF_SOURCE_MAX_BYTES) return 1;
    const source = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
    for (const candidate of [before, after].filter(Boolean)) {
      const index = source.indexOf(candidate);
      if (index >= 0) return source.slice(0, index).split("\n").length;
    }
  } catch {
    // Deleted and remote-only files fall back to snippet-relative numbering.
  }
  return 1;
}

function logicalLineCount(value: string): number {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized) return 0;
  const withoutFinalTerminator = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalTerminator.split("\n").length;
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
  options: { cwd?: string } = {},
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

  if (shortName === "ask_session" || shortName === "tell_session") {
    const message = summarizePrimitive(input.message);
    if (typeof message === "string") summary.message = message;
  }

  if (shortName === "edit" || shortName === "delete") {
    const rawBefore = input.before ?? input.old_string;
    const rawAfter = input.after ?? input.new_string;
    const before = summarizeDiffText(rawBefore);
    if (before !== undefined) summary.before = before;
    if (shortName === "edit") {
      const after = summarizeDiffText(rawAfter);
      if (after !== undefined) summary.after = after;
    }
    const normalizedBefore =
      typeof rawBefore === "string" ? rawBefore.replace(/\r\n?/g, "\n") : undefined;
    const normalizedAfter =
      typeof rawAfter === "string" ? rawAfter.replace(/\r\n?/g, "\n") : undefined;
    const generatedPreview =
      options.cwd &&
      normalizedBefore !== undefined &&
      (shortName === "delete" || normalizedAfter !== undefined)
        ? buildNumberedDiffSummary(
            normalizedBefore,
            shortName === "edit" ? (normalizedAfter ?? "") : "",
            sourceStartLine(
              input,
              normalizedBefore,
              shortName === "edit" ? (normalizedAfter ?? "") : "",
              options.cwd,
            ),
          ).diffPreview
        : undefined;
    const diffPreview = summarizeDiffText(input.diff_preview ?? generatedPreview);
    if (diffPreview !== undefined) summary.diff_preview = diffPreview;
  }
  if (shortName === "write") {
    const content =
      typeof input.content === "string"
        ? input.content
        : typeof input.after === "string"
          ? input.after
          : undefined;
    const preview = summarizeDiffText(content);
    if (preview !== undefined) summary.preview = preview;
    if (content !== undefined) summary.lines = logicalLineCount(content);
    const normalizedContent = content?.replace(/\r\n?/g, "\n");
    const generatedPreview =
      options.cwd && normalizedContent !== undefined
        ? buildNumberedDiffSummary(
            "",
            normalizedContent,
            sourceStartLine(input, "", normalizedContent, options.cwd),
          ).diffPreview
        : undefined;
    const diffPreview = summarizeDiffText(input.diff_preview ?? generatedPreview);
    if (diffPreview !== undefined) summary.diff_preview = diffPreview;
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function formatToolUse(name: string, input: Record<string, unknown>): string {
  const rawCommand = input.command || input.cmd;
  const shortName = name.split("__").at(-1)?.toLowerCase() ?? name.toLowerCase();
  const displayName =
    shortName === "bash" && rawCommand ? classifyShellToolName(String(rawCommand)) : name;
  let detail = "";
  if (displayName === "View" && input.question) {
    const file = input.image_path || input.file_path || input.path;
    const fileName = typeof file === "string" ? file.split("/").pop() : "";
    const suffix = fileName ? ` [${fileName}]` : "";
    detail = `${String(input.question)}${suffix}`;
  } else if ((displayName === "Agent" || displayName === "Task") && input.subagent_type) {
    const type = String(input.subagent_type);
    const desc = input.description ? ` ${String(input.description).slice(0, 60)}` : "";
    detail = `[${type}]${desc}`;
  } else if (rawCommand) {
    const command = summarizeShellCommand(String(rawCommand));
    detail =
      (displayName === "Read" || displayName === "Search") && command.includes(" ")
        ? command.slice(command.indexOf(" ") + 1)
        : command;
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
    return `${displayName}(${detail.length > 100 ? `${detail.slice(0, 100)}...` : detail})`;
  }
  return displayName;
}
