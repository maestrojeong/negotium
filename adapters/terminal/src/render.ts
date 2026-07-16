import {
  getRegistry,
  type MessageDto,
  resolveModelForAgent,
  SELECTABLE_MODELS,
  type TopicDto,
} from "@negotium/core";
import { terminalNowMs } from "@/clock";
import { commandSuggestions } from "@/commands";
import {
  type AppState,
  activeMessages,
  activeQuestion,
  activeTaskPanel,
  activeTopic,
  pickedBackgroundSession,
} from "@/state";

type Rgb = readonly [number, number, number];

const theme = {
  canvas: [10, 11, 15] as Rgb,
  surface: [18, 20, 27] as Rgb,
  surfaceRaised: [24, 27, 36] as Rgb,
  selected: [42, 37, 69] as Rgb,
  border: [48, 52, 67] as Rgb,
  borderActive: [119, 103, 239] as Rgb,
  text: [232, 233, 239] as Rgb,
  muted: [137, 141, 158] as Rgb,
  subtle: [91, 95, 112] as Rgb,
  accent: [139, 124, 246] as Rgb,
  cyan: [87, 205, 220] as Rgb,
  green: [94, 211, 142] as Rgb,
  amber: [241, 190, 91] as Rgb,
  red: [245, 116, 128] as Rgb,
};

// cli-spinners' compact "dots" pattern: fast, stable-width, and reads as
// active computation rather than a slow mechanical wheel.
const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const WORKING_FRAME_INTERVAL_MS = 50;

export function workingFrame(frame: number): string {
  const index = Math.abs(Math.trunc(frame)) % WORKING_FRAMES.length;
  return WORKING_FRAMES[index] ?? WORKING_FRAMES[0];
}

export function workingElapsedSeconds(
  startedAtMs: number | undefined,
  nowMs = terminalNowMs(),
): number {
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}

export function formatElapsedDuration(totalSeconds: number): string {
  const elapsed = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const days = Math.floor(elapsed / 86_400);
  const hours = Math.floor((elapsed % 86_400) / 3_600);
  const minutes = Math.floor((elapsed % 3_600) / 60);
  const seconds = elapsed % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Hide legacy cross-agent defaults such as codex + deepseek-pro. */
export function effectiveTopicModel(topic: TopicDto | null): string {
  if (!topic?.agent) return topic?.defaultModel ?? "-";
  return resolveModelForAgent(
    topic.agent,
    topic.effectiveModel ?? topic.defaultModel,
    getRegistry(topic.agent),
  );
}

interface UiLine {
  text: string;
  fg?: Rgb;
  bg?: Rgb;
  bold?: boolean;
  dim?: boolean;
}

export interface RenderedTerminalApp {
  frame: string;
  cursor: { x: number; y: number } | null;
}

const ESC = "\u001b[";
const RESET = `${ESC}0m`;
const fg = ([r, g, b]: Rgb) => `${ESC}38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: Rgb) => `${ESC}48;2;${r};${g};${b}m`;

function paint(
  value: string,
  options: { fg?: Rgb; bg?: Rgb; bold?: boolean; dim?: boolean } = {},
): string {
  return `${options.fg ? fg(options.fg) : ""}${options.bg ? bg(options.bg) : ""}${options.bold ? `${ESC}1m` : ""}${options.dim ? `${ESC}2m` : ""}${value}${RESET}`;
}

export function stripAnsi(value: string): string {
  // biome-ignore lint/complexity/useRegexLiterals: avoids literal terminal control bytes in source.
  return value.replace(new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g"), "");
}

function safeText(value: string): string {
  return [...stripAnsi(value).replaceAll("\r", "")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
}

function runeWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      code >= 0x20000)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(value: string): number {
  return [...stripAnsi(value)].reduce((width, char) => width + runeWidth(char), 0);
}

function sliceWidth(value: string, width: number): string {
  let out = "";
  let used = 0;
  for (const char of [...safeText(value)]) {
    const next = runeWidth(char);
    if (used + next > width) break;
    out += char;
    used += next;
  }
  return out;
}

function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const clean = safeText(value).replaceAll("\n", " ");
  const clipped = sliceWidth(clean, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

function joinSides(left: string, right: string, width: number): string {
  const safeLeft = sliceWidth(left, width);
  const remaining = Math.max(1, width - displayWidth(safeLeft));
  const safeRight = sliceWidth(right, remaining);
  const gap = Math.max(1, width - displayWidth(safeLeft) - displayWidth(safeRight));
  return fit(`${safeLeft}${" ".repeat(gap)}${safeRight}`, width);
}

export function wrapText(value: string, width: number): string[] {
  if (width <= 1) return [sliceWidth(value, Math.max(0, width))];
  const output: string[] = [];
  for (const paragraph of safeText(value).split("\n")) {
    if (!paragraph) {
      output.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const character of [...paragraph]) {
      const characterWidth = runeWidth(character);
      if (currentWidth + characterWidth > width && current) {
        output.push(current);
        current = "";
        currentWidth = 0;
      }
      current += character;
      currentWidth += characterWidth;
    }
    output.push(current);
  }
  return output.length > 0 ? output : [""];
}

function line(text: string, options: Omit<UiLine, "text"> = {}): UiLine {
  return { text, ...options };
}

function framePane(
  title: string,
  content: UiLine[],
  width: number,
  height: number,
  options: { active?: boolean; accent?: Rgb } = {},
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const borderColor = options.active ? (options.accent ?? theme.borderActive) : theme.border;
  const label = ` ${sliceWidth(title, Math.max(0, innerWidth - 3))} `;
  const top = paint(`╭${label}${"─".repeat(Math.max(0, innerWidth - displayWidth(label)))}╮`, {
    fg: borderColor,
    bg: theme.canvas,
    bold: true,
  });
  const body = Array.from({ length: Math.max(0, height - 2) }, (_, index) => {
    const item = content[index] ?? line("");
    const side = paint("│", { fg: borderColor, bg: theme.canvas });
    const cell = paint(fit(item.text, innerWidth), {
      fg: item.fg ?? theme.text,
      bg: item.bg ?? theme.surface,
      bold: item.bold,
      dim: item.dim,
    });
    return `${side}${cell}${side}`;
  });
  const bottom = paint(`╰${"─".repeat(innerWidth)}╯`, {
    fg: borderColor,
    bg: theme.canvas,
  });
  return [top, ...body, bottom];
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<!\*)\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "‹$1›");
}

/** Lightweight block renderer adapted to agent replies: headings, lists, quotes and fenced code. */
export function renderMarkdown(value: string, width: number): UiLine[] {
  const result: UiLine[] = [];
  let codeLanguage = "";
  let inCode = false;
  for (const rawLine of safeText(value).split("\n")) {
    const fence = rawLine.match(/^\s*```([^`]*)$/);
    if (fence) {
      if (!inCode) {
        codeLanguage = fence[1]?.trim() ?? "";
        result.push(
          line(`  ┌─ code${codeLanguage ? ` · ${codeLanguage}` : ""}`, {
            fg: theme.cyan,
            bg: theme.surfaceRaised,
            bold: true,
          }),
        );
      } else {
        result.push(line("  └─", { fg: theme.subtle, bg: theme.surfaceRaised }));
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      for (const wrapped of wrapText(rawLine || " ", Math.max(4, width - 4))) {
        result.push(line(`  │ ${wrapped}`, { fg: theme.text, bg: theme.surfaceRaised }));
      }
      continue;
    }
    const heading = rawLine.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      for (const wrapped of wrapText(cleanInlineMarkdown(heading[2]), Math.max(4, width - 2))) {
        result.push(line(`  ${wrapped}`, { fg: theme.accent, bold: true }));
      }
      continue;
    }
    const bullet = rawLine.match(/^\s*[-+*]\s+(.+)$/);
    if (bullet) {
      for (const [index, wrapped] of wrapText(
        cleanInlineMarkdown(bullet[1]),
        Math.max(4, width - 5),
      ).entries()) {
        result.push(line(`  ${index === 0 ? "•" : " "} ${wrapped}`, { fg: theme.text }));
      }
      continue;
    }
    const ordered = rawLine.match(/^\s*(\d+[.)])\s+(.+)$/);
    if (ordered) {
      const marker = ordered[1];
      for (const [index, wrapped] of wrapText(
        cleanInlineMarkdown(ordered[2]),
        Math.max(4, width - marker.length - 4),
      ).entries()) {
        result.push(line(`  ${index === 0 ? marker : " ".repeat(marker.length)} ${wrapped}`));
      }
      continue;
    }
    const quote = rawLine.match(/^\s*>\s?(.*)$/);
    if (quote) {
      for (const wrapped of wrapText(cleanInlineMarkdown(quote[1]), Math.max(4, width - 5))) {
        result.push(line(`  ▏ ${wrapped}`, { fg: theme.muted }));
      }
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(rawLine)) {
      result.push(line(`  ${"─".repeat(Math.max(1, width - 4))}`, { fg: theme.border }));
      continue;
    }
    if (!rawLine.trim()) {
      result.push(line(""));
      continue;
    }
    for (const wrapped of wrapText(cleanInlineMarkdown(rawLine), Math.max(4, width - 2))) {
      result.push(line(`  ${wrapped}`, { fg: theme.text }));
    }
  }
  if (inCode) result.push(line("  └─", { fg: theme.subtle, bg: theme.surfaceRaised }));
  return result;
}

function subagentLines(message: MessageDto, width: number): UiLine[] {
  const card = message.subagentCard;
  if (!card) return [];
  const done = card.status === "completed";
  const failed = card.status === "failed";
  const color = failed ? theme.red : done ? theme.green : theme.cyan;
  const output = card.errorMessage ?? card.resultSummary ?? card.task;
  return [
    line(`  ↳ ${card.name}  ${card.status}`, { fg: color, bold: true }),
    ...wrapText(output, Math.max(4, width - 6))
      .slice(0, 4)
      .map((text) => line(`    ${text}`, { fg: theme.muted })),
    line(""),
  ];
}

function isVisibleSystemMessage(message: MessageDto): boolean {
  return message.sourceAdapter === "session-comm" || message.id.startsWith("tell-");
}

function messageLines(message: MessageDto, width: number, userId: string): UiLine[] {
  if (
    message.kind === "system" ||
    (message.authorId === "system" && !isVisibleSystemMessage(message))
  ) {
    return [];
  }
  if (message.kind === "subagent" && message.subagentCard) return subagentLines(message, width);
  if (message.kind === "tool") {
    const [title = "Tool", ...details] = safeText(message.text).split("\n");
    const done = Boolean(message.editedAt);
    return [
      line(`  ${done ? "✓" : "●"} ${title}`, {
        fg: done ? theme.green : theme.cyan,
        dim: done,
      }),
      ...details.slice(0, 2).flatMap((detail) =>
        wrapText(detail, Math.max(4, width - 6))
          .slice(0, 1)
          .map((text) =>
            line(`    ${text}`, {
              fg: detail.startsWith("-")
                ? theme.red
                : detail.startsWith("+")
                  ? theme.green
                  : theme.muted,
              dim: true,
            }),
          ),
      ),
    ];
  }
  const own = message.authorId === userId;
  const ai = message.authorId === "ai";
  const icon = own ? "›" : ai ? "●" : "•";
  const body = ai
    ? renderMarkdown(message.text, Math.max(4, width - 6))
    : wrapText(message.text, Math.max(4, width - 6)).map((text, index) =>
        line(`${index === 0 ? `  ${icon} ` : "    "}${text}`, {
          fg: theme.text,
          bg: theme.surfaceRaised,
        }),
      );
  if (ai) {
    const firstContent = body.findIndex((item) => item.text.trim().length > 0);
    if (firstContent >= 0) {
      const first = body[firstContent];
      body[firstContent] = {
        ...first,
        text: `  ${icon} ${first.text.trimStart()}`,
      };
    }
  }
  if (!ai) {
    const padding = line("", { bg: theme.surfaceRaised });
    return [padding, ...body, padding, line("")];
  }
  return [...body, line("")];
}

function activityDetail(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("Working…")) return undefined;
  if (raw.startsWith("Thinking…")) return "Thinking";
  const running = raw.match(/^(.*?) running \d+s$/u);
  return running?.[1]?.trim() || raw;
}

function activityLines(state: AppState, animationFrame = 0, nowMs = terminalNowMs()): UiLine[] {
  const topic = activeTopic(state);
  if (!topic) return [];
  const activity = state.activity[topic.id];
  if (!activity) return [];
  const result: UiLine[] = [];
  if (activity.running) {
    const detail = activityDetail(activity.status);
    const lastToolLabel = activity.tools.at(-1)?.label;
    const elapsed = workingElapsedSeconds(activity.startedAtMs, nowMs);
    result.push(
      line(
        `  ${workingFrame(animationFrame)} Working · ${formatElapsedDuration(elapsed)}${detail && detail !== lastToolLabel ? ` · ${detail}` : ""}`,
        { fg: theme.amber, bold: true },
      ),
    );
  } else if (activity.error) {
    result.push(line(`  ! ${activity.error}`, { fg: theme.red }));
  }
  if (result.length > 0) result.push(line(""));
  return result;
}

function taskLines(state: AppState, width: number): UiLine[] {
  const taskPanel = activeTaskPanel(state);
  if (!taskPanel) return [];
  return [
    line("  ◫ Tasks", { fg: theme.amber, bold: true }),
    ...safeText(taskPanel.text)
      .split("\n")
      .slice(1, 6)
      .flatMap((task) =>
        wrapText(task.trimStart(), Math.max(4, width - 6)).map((text) =>
          line(`    ${text}`, { fg: theme.muted }),
        ),
      ),
    line(""),
  ];
}

function helpLines(): UiLine[] {
  return [
    line("  Keyboard", { fg: theme.accent, bold: true }),
    line(""),
    line("  Alt-Enter newline"),
    line("  ← → move · Ctrl/Alt-← → move by word · ↑ ↓ history"),
    line("  Ctrl-W delete word · Ctrl-U/K clear before/after cursor"),
    line("  Mouse wheel / PgUp/PgDn scroll · Ctrl-E load older · Ctrl-T transcript"),
    line("  Ctrl-O topics · Ctrl-P/N previous/next topic"),
    line("  Esc/Ctrl-C stop active turn · Ctrl-C twice when idle to quit"),
    line(""),
    line("  Commands", { fg: theme.cyan, bold: true }),
    line("  /new  /model  /topics  /fork  /spawn  /del  /copy"),
    line("  /abort  /help  /quit", { fg: theme.muted }),
  ];
}

function tokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "unavailable";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function statusLines(state: AppState): UiLine[] {
  const topic = activeTopic(state);
  const latest = activeMessages(state)
    .slice()
    .reverse()
    .find((message) => message.authorId === "ai" && message.usage);
  const usage = latest?.usage;
  const ratio =
    usage?.context !== undefined && usage.contextWindow
      ? Math.round((usage.context / usage.contextWindow) * 100)
      : undefined;
  return [
    line("  Status", { fg: theme.accent, bold: true }),
    line(""),
    line(`  Topic       ${topic?.title ?? "none"}`),
    line(`  Agent       ${topic?.agent ?? "none"}`),
    line(`  Model       ${effectiveTopicModel(topic)}`),
    line(""),
    line(
      `  Context     ${tokenCount(usage?.context)} / ${tokenCount(usage?.contextWindow)}${ratio === undefined ? "" : ` (${ratio}%)`}`,
      { fg: ratio !== undefined && ratio >= 80 ? theme.amber : theme.text },
    ),
    line("  Measured on the latest model request", { fg: theme.muted, dim: true }),
    line(""),
    line(`  Last turn   input ${tokenCount(usage?.input)} · output ${tokenCount(usage?.output)}`),
    line(`  Cache read  ${tokenCount(usage?.cachedInput)}`),
    line("  Turn input is aggregate spend; it is not context size.", {
      fg: theme.muted,
      dim: true,
    }),
    line(""),
    line("  Esc close", { fg: theme.muted }),
  ];
}

export function plainTranscript(state: AppState): string {
  const topic = activeTopic(state);
  const rows = [`# ${topic?.title ?? "Conversation"}`];
  for (const message of activeMessages(state).filter(
    (item) =>
      !item.id.startsWith("tasks-") &&
      item.kind !== "tool" &&
      item.kind !== "system" &&
      (item.authorId !== "system" || isVisibleSystemMessage(item)),
  )) {
    const author =
      message.authorId === state.userId
        ? "You"
        : message.authorId === "ai"
          ? state.aiName
          : "System";
    rows.push("", `${author}:`, safeText(message.text));
  }
  return rows.join("\n");
}

type TopicOverlayEntry =
  | { kind: "manager" }
  | { kind: "heading"; label: string }
  | { kind: "separator" }
  | { kind: "topic"; topic: TopicDto; topicIndex: number }
  | { kind: "background"; sessionId: string; label: string; status: string };

function topicOverlayLines(
  state: AppState,
  width: number,
  height: number,
  animationFrame = 0,
): UiLine[] {
  const indexedTopics = state.topics.map((topic, topicIndex) => ({ topic, topicIndex }));
  const general = indexedTopics.filter(({ topic }) => topic.title.toLowerCase() === "general");
  const otherTopics = indexedTopics.filter(({ topic }) => topic.title.toLowerCase() !== "general");
  const entries: TopicOverlayEntry[] = [];
  if (general.length > 0) {
    entries.push(
      { kind: "manager" },
      ...general.map(({ topic, topicIndex }) => ({ kind: "topic" as const, topic, topicIndex })),
    );
  }
  if (otherTopics.length > 0) {
    if (general.length > 0) entries.push({ kind: "separator" });
    entries.push({ kind: "heading", label: "Worker" });
    entries.push(
      ...otherTopics.map(({ topic, topicIndex }) => ({
        kind: "topic" as const,
        topic,
        topicIndex,
      })),
    );
  }
  for (const kind of ["memory", "cron"] as const) {
    const sessions = state.backgroundSessions.filter((session) => session.kind === kind);
    if (sessions.length === 0) continue;
    if (entries.length > 0) entries.push({ kind: "separator" });
    entries.push({ kind: "heading", label: kind === "memory" ? "Memory" : "Cron" });
    entries.push(
      ...sessions.map((session) => ({
        kind: "background" as const,
        sessionId: session.id,
        label: session.title,
        status: session.status,
      })),
    );
  }
  const visibleCount = Math.max(1, height - 3);
  const selectedEntryIndex = entries.findIndex(
    (entry) =>
      (entry.kind === "topic" &&
        !state.topicPickerBackgroundId &&
        entry.topicIndex === state.topicPickerIndex) ||
      (entry.kind === "background" && entry.sessionId === state.topicPickerBackgroundId),
  );
  let start = Math.min(
    Math.max(0, entries.length - visibleCount),
    Math.max(0, selectedEntryIndex - visibleCount + 1),
  );
  if (
    start > 0 &&
    entries[start - 1]?.kind === "manager" &&
    selectedEntryIndex - (start - 1) < visibleCount
  ) {
    start -= 1;
  }

  return [
    line("  Topics", { fg: theme.accent, bold: true }),
    line(
      state.topicPickerRoot
        ? "  ↑↓ select · Enter open · N new · D/Del delete · Esc/Ctrl-C exit"
        : "  ↑↓ select · Enter open · N new · D/Del delete · Esc close · Ctrl-C exit; work continues",
      { fg: theme.muted },
    ),
    line(""),
    ...(entries.length === 0
      ? [line("  No topics yet · Press N to create one", { fg: theme.muted })]
      : entries.slice(start, start + visibleCount).map((entry) => {
          if (entry.kind === "manager") {
            return line("  Manager", { fg: theme.cyan, bold: true });
          }
          if (entry.kind === "heading") {
            return line(`  ${entry.label}`, { fg: theme.cyan, bold: true });
          }
          if (entry.kind === "separator") {
            return line(`  ${"─".repeat(Math.max(1, width - 4))}`, { fg: theme.border });
          }
          if (entry.kind === "background") {
            const selected = entry.sessionId === state.topicPickerBackgroundId;
            return line(
              `  ${selected ? "›" : " "} ${workingFrame(animationFrame)} ${entry.label}  ·  ${entry.status}`,
              {
                fg: selected ? theme.text : theme.green,
                bg: selected ? theme.selected : theme.canvas,
                bold: selected,
              },
            );
          }
          const { topic, topicIndex } = entry;
          const selected = topicIndex === state.topicPickerIndex;
          const running = state.activity[topic.id]?.running;
          const childPrefix = topic.isSubagent ? "  ↳ " : "";
          return line(
            `  ${selected ? "›" : " "} ${childPrefix}${running ? workingFrame(animationFrame) : "○"} ${topic.title}  ·  ${topic.agent ?? "no agent"}  ·  ${effectiveTopicModel(topic)}`,
            {
              fg: selected ? theme.text : running ? theme.green : theme.muted,
              bg: selected ? theme.selected : theme.canvas,
              bold: selected,
            },
          );
        })),
  ];
}

function backgroundSessionLines(state: AppState, nowMs = terminalNowMs()): UiLine[] {
  const session = pickedBackgroundSession(state);
  if (!session) return [line("  This background session has finished.", { fg: theme.muted })];
  const elapsed = formatElapsedDuration(
    Math.max(0, Math.floor((nowMs - Date.parse(session.startedAt)) / 1_000)),
  );
  return [
    line(`  ${session.kind === "memory" ? "Memory" : "Cron"} · read-only`, {
      fg: theme.accent,
      bold: true,
    }),
    line("  Esc back · this entry disappears when the run finishes", { fg: theme.muted }),
    line(""),
    line(`  ${session.title}`, { bold: true }),
    line(`  ${session.status} · ${elapsed}`, { fg: theme.green }),
    ...(session.agent || session.model
      ? [line(`  ${session.agent ?? "-"} · ${session.model ?? "default"}`, { fg: theme.muted })]
      : []),
    line(""),
    line("  Activity", { fg: theme.cyan, bold: true }),
    ...(session.steps.length > 0
      ? session.steps.map((step) => line(`  ○ ${safeText(step)}`, { fg: theme.muted }))
      : [line("  ○ Waiting for runtime activity", { fg: theme.muted })]),
  ];
}

function modelOverlayLines(state: AppState, height: number): UiLine[] {
  const currentModel = effectiveTopicModel(activeTopic(state));
  const modelColumnWidth = Math.max(
    ...SELECTABLE_MODELS.map(({ model }) => `${model} (current)`.length),
  );
  const visibleCount = Math.max(1, height - 3);
  const start = Math.min(
    Math.max(0, SELECTABLE_MODELS.length - visibleCount),
    Math.max(0, state.modelPickerIndex - visibleCount + 1),
  );
  return [
    line("  Models", { fg: theme.accent, bold: true }),
    line("  ↑↓ select · Enter apply · Esc close", { fg: theme.muted }),
    line(""),
    ...SELECTABLE_MODELS.slice(start, start + visibleCount).map(
      ({ model, description }, visibleIndex) => {
        const index = start + visibleIndex;
        const selected = index === state.modelPickerIndex;
        const current = model === currentModel;
        const label = `${model}${current ? " (current)" : ""}`.padEnd(modelColumnWidth);
        return line(`  ${selected ? "›" : " "} ${label}  ${description}`, {
          fg: selected ? theme.text : current ? theme.green : theme.muted,
          bg: selected ? theme.selected : theme.canvas,
          bold: selected,
        });
      },
    ),
  ];
}

function conversationContentLines(
  state: AppState,
  width: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
): UiLine[] {
  const all: UiLine[] = [];
  for (const message of activeMessages(state).filter(
    (item) =>
      !item.id.startsWith("tasks-") &&
      item.kind !== "system" &&
      (item.authorId !== "system" || isVisibleSystemMessage(item)),
  )) {
    all.push(...messageLines(message, width, state.userId));
  }
  all.push(...activityLines(state, animationFrame, nowMs), ...taskLines(state, width));
  if (all.length === 0) {
    all.push(
      line(""),
      line("  ✦ Start a conversation", { fg: theme.accent, bold: true }),
      line("  Ask, build, research, or delegate from the composer below.", { fg: theme.muted }),
    );
  }
  return all;
}

function conversationLines(
  state: AppState,
  width: number,
  height: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
): UiLine[] {
  if (state.overlay === "help") return helpLines().slice(0, height);
  if (state.overlay === "status") return statusLines(state).slice(0, height);
  if (state.overlay === "topics")
    return topicOverlayLines(state, width, height, animationFrame).slice(0, height);
  if (state.overlay === "background-session")
    return backgroundSessionLines(state, nowMs).slice(0, height);
  if (state.overlay === "models") return modelOverlayLines(state, height).slice(0, height);
  if (state.creatingTopic) {
    return [
      line(""),
      line("  New topic", { fg: theme.accent, bold: true }),
      line(""),
      line("  Type only the topic name in the composer below."),
      line("  Enter create · Esc cancel", { fg: theme.muted }),
    ].slice(0, height);
  }
  if (state.overlay === "transcript") {
    return [
      line("  Transcript · Ctrl-T close", { fg: theme.accent, bold: true }),
      line(""),
      ...plainTranscript(state)
        .split("\n")
        .flatMap((text) => wrapText(text, Math.max(4, width - 4)).map((part) => line(`  ${part}`))),
    ].slice(0, height);
  }
  if (state.overlay === "confirm-delete") {
    const topic = state.topics.find((candidate) => candidate.id === state.pendingDeleteTopicId);
    return [
      line(""),
      line(`  Delete “${topic?.title ?? "this topic"}”?`, { fg: theme.red, bold: true }),
      line(""),
      line("  The transcript is archived before the topic and its runtime state are removed."),
      line("  Press y to delete or n to cancel.", { fg: theme.amber }),
    ].slice(0, height);
  }

  const all = conversationContentLines(state, width, animationFrame, nowMs);
  const { contentHeight, maxOffset, offset } = conversationViewport(
    all.length,
    height,
    state.scrollOffset,
  );
  const end = all.length - offset;
  const visible = all.slice(Math.max(0, end - contentHeight), end);
  const history = state.activeTopicId ? state.messageHistory[state.activeTopicId] : undefined;
  const marker =
    offset >= maxOffset && history?.loading
      ? "  ↑ Loading older messages…"
      : offset >= maxOffset && history?.hasMore
        ? "  ↑ Loaded history start · Ctrl-E load older"
        : offset >= maxOffset
          ? "  ↑ Start of conversation"
          : `  ↑ history · ${offset} lines from latest · wheel down/PgDn to return`;
  return offset > 0
    ? [
        line(marker, {
          fg: theme.amber,
          dim: true,
        }),
        ...visible,
      ]
    : visible;
}

function conversationViewport(
  lineCount: number,
  height: number,
  requestedOffset: number,
): { contentHeight: number; maxOffset: number; offset: number } {
  if (lineCount <= height) return { contentHeight: height, maxOffset: 0, offset: 0 };
  const contentHeight = Math.max(1, height - 1);
  const maxOffset = Math.max(0, lineCount - contentHeight);
  return {
    contentHeight,
    maxOffset,
    offset: Math.min(maxOffset, Math.max(0, requestedOffset)),
  };
}

function decisionPane(state: AppState, width: number): string[] {
  if (state.overlay) return [];
  const ask = activeQuestion(state);
  const question = ask?.askUserQuestion;
  if (!ask || !question?.choices.length) return [];
  const selected = Math.min(state.askChoiceIndex, question.choices.length - 1);
  const content: UiLine[] = [
    line(`  ${question.question}`, { bold: true }),
    ...question.choices.map((choice, index) =>
      line(
        `  ${index === selected ? "●" : "○"} ${choice.label}${choice.description ? ` — ${choice.description}` : ""}`,
        {
          fg: index === selected ? theme.text : theme.muted,
          bg: index === selected ? theme.selected : theme.surface,
          bold: index === selected,
        },
      ),
    ),
  ];
  return framePane(
    "decision required · ↑↓ select · Enter confirm",
    content,
    width,
    Math.min(8, Math.max(4, content.length + 2)),
    { active: true, accent: theme.amber },
  );
}

interface InputVisual {
  lines: UiLine[];
  cursorLine: number;
  cursorColumn: number;
}

function wrappedCursorPosition(
  value: string,
  codePointColumn: number,
  width: number,
): { line: number; column: number } {
  let line = 0;
  let column = 0;
  for (const character of Array.from(value).slice(0, Math.max(0, codePointColumn))) {
    const characterWidth = runeWidth(character);
    if (column + characterWidth > width && column > 0) {
      line += 1;
      column = 0;
    }
    column += characterWidth;
  }
  return { line, column };
}

function inputVisualLines(state: AppState, width: number): InputVisual {
  if (!state.input) {
    return {
      lines: [
        line(
          `  ›   ${state.creatingTopic ? "Type a topic name…" : "Type a message or /command…"}`,
          {
            fg: theme.subtle,
            bg: theme.surfaceRaised,
          },
        ),
      ],
      cursorLine: 0,
      cursorColumn: 5,
    };
  }
  const contentWidth = Math.max(4, width - 5);
  const result: UiLine[] = [];
  let cursorLine = 0;
  let cursorColumn = 5;
  for (const [row, inputLine] of state.input.split("\n").entries()) {
    const firstVisualLine = result.length;
    if (row === state.inputCursor.row) {
      const cursor = wrappedCursorPosition(inputLine, state.inputCursor.col, contentWidth);
      cursorLine = firstVisualLine + cursor.line;
      cursorColumn = 5 + cursor.column;
    }
    for (const [visualIndex, wrapped] of wrapText(inputLine, contentWidth).entries()) {
      result.push(
        line(`${row === 0 && visualIndex === 0 ? "  › " : "    "}${wrapped}`, {
          bg: theme.surfaceRaised,
        }),
      );
    }
  }
  return { lines: result, cursorLine, cursorColumn };
}

interface ComposerPane {
  lines: string[];
  cursor: { x: number; y: number };
}

function composerPane(state: AppState, width: number): ComposerPane {
  const title = state.creatingTopic ? "new topic · type a name · Enter create" : "Ctrl-O topics";
  const visual = inputVisualLines(state, width);
  let inputStart = Math.max(0, visual.lines.length - 5);
  if (visual.cursorLine < inputStart) inputStart = visual.cursorLine;
  else if (visual.cursorLine >= inputStart + 5) inputStart = visual.cursorLine - 4;
  const inputLines = visual.lines.slice(inputStart, inputStart + 5);
  const visibleCursorLine = visual.cursorLine - inputStart;
  const suggestions = state.creatingTopic ? [] : commandSuggestions(state.input);
  const suggestionLines = suggestions
    .slice(0, Math.max(0, 6 - inputLines.length))
    .map((command, index) =>
      line(
        `    ${index === state.suggestionIndex ? "›" : " "} ${command.usage}  ${command.description}`,
        {
          fg: index === state.suggestionIndex ? theme.text : theme.muted,
          bg: index === state.suggestionIndex ? theme.selected : theme.surface,
        },
      ),
    );
  const content = [line(""), ...inputLines, line(""), ...suggestionLines].slice(0, 8);
  const input = content.map((item) =>
    paint(fit(item.text, width), {
      fg: item.fg ?? theme.text,
      bg: item.bg ?? theme.surfaceRaised,
      bold: item.bold,
      dim: item.dim,
    }),
  );
  const hint = paint(fit(`  ${title}`, width), { fg: theme.muted, bg: theme.canvas });
  return {
    lines: state.creatingTopic ? [hint, ...input] : [...input, hint],
    cursor: {
      x: visual.cursorColumn,
      y: 2 + visibleCursorLine + (state.creatingTopic ? 1 : 0),
    },
  };
}

function footerLines(state: AppState, width: number): string[] {
  if (state.creatingTopic) {
    return [
      paint(joinSides("  New topic", "○ naming  ", width), {
        fg: theme.accent,
        bg: theme.surfaceRaised,
        bold: true,
      }),
      paint(joinSides("", "Esc cancel  ", width), {
        fg: theme.muted,
        bg: theme.canvas,
      }),
    ];
  }
  const topic = activeTopic(state);
  const running = Boolean(topic && state.activity[topic.id]?.running);
  return [
    paint(
      joinSides(
        `  ${topic?.title ?? "no topic"} · ${topic?.agent ?? "-"} · ${effectiveTopicModel(topic)}`,
        "",
        width,
      ),
      {
        fg: theme.accent,
        bg: theme.surfaceRaised,
        bold: true,
      },
    ),
    paint(
      joinSides(
        "",
        state.notice
          ? `! ${state.notice}  `
          : state.overlay === "topics"
            ? state.topicPickerRoot
              ? "Esc/Ctrl-C exit  "
              : "Esc close · Ctrl-C exit; work continues  "
            : state.overlay === "background-session"
              ? "Esc back · read-only  "
              : running
                ? "Esc/Ctrl-C stop  "
                : "Ctrl-C twice to quit  ",
        width,
      ),
      {
        fg: state.notice ? theme.amber : theme.muted,
        bg: theme.canvas,
      },
    ),
  ];
}

function renderBody(lines: UiLine[], width: number, height: number): string[] {
  return Array.from({ length: height }, (_, index) => {
    const item = lines[index] ?? line("");
    return paint(fit(item.text, width), {
      fg: item.fg ?? theme.text,
      bg: item.bg ?? theme.canvas,
      bold: item.bold,
      dim: item.dim,
    });
  });
}

export function renderApp(
  state: AppState,
  columns: number,
  rows: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
): string {
  return renderAppFrame(state, columns, rows, animationFrame, nowMs).frame;
}

export function renderAppFrame(
  state: AppState,
  columns: number,
  rows: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
): RenderedTerminalApp {
  const width = Math.max(32, columns);
  const height = Math.max(14, rows);
  const footer = footerLines(state, width);
  const decision = decisionPane(state, width);
  const readOnlyBackground = state.overlay === "background-session";
  const composer = readOnlyBackground ? { lines: [], cursor: null } : composerPane(state, width);
  const bodyHeight = Math.max(3, height - footer.length - decision.length - composer.lines.length);
  const body = renderBody(
    conversationLines(state, width, bodyHeight, animationFrame, nowMs),
    width,
    bodyHeight,
  );
  const cursorY = composer.cursor
    ? body.length + decision.length + composer.cursor.y
    : Number.POSITIVE_INFINITY;
  return {
    frame: [...body, ...decision, ...composer.lines, ...footer].slice(0, height).join("\n"),
    cursor: composer.cursor && cursorY <= height ? { x: composer.cursor.x, y: cursorY } : null,
  };
}

export function maxConversationScrollOffset(
  state: AppState,
  columns: number,
  rows: number,
): number {
  if (state.overlay) return 0;
  const width = Math.max(32, columns);
  const height = Math.max(14, rows);
  const bodyHeight = Math.max(
    3,
    height -
      footerLines(state, width).length -
      decisionPane(state, width).length -
      composerPane(state, width).lines.length,
  );
  const lineCount = conversationContentLines(state, width).length;
  return conversationViewport(lineCount, bodyHeight, state.scrollOffset).maxOffset;
}
