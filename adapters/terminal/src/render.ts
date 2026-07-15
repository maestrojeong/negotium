import { getRegistry, type MessageDto, resolveModelForAgent, type TopicDto } from "@negotium/core";
import { terminalNowMs } from "@/clock";
import { commandSuggestions } from "@/commands";
import {
  type AppState,
  activeMessages,
  activeQuestion,
  activeTaskPanel,
  activeTopic,
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
export const WORKING_FRAME_INTERVAL_MS = 16;

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

function timestamp(message: MessageDto): string {
  const date = new Date(message.createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

function messageLines(
  message: MessageDto,
  width: number,
  userId: string,
  aiName: string,
): UiLine[] {
  if (message.kind === "system" || message.authorId === "system") return [];
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
  const system = !own && !ai;
  const name = own ? "You" : ai ? aiName : "System";
  const color = own ? theme.cyan : ai ? theme.accent : theme.muted;
  const icon = own ? "›" : ai ? "✦" : "•";
  const header = joinSides(`  ${icon} ${name}`, timestamp(message), Math.max(1, width - 2));
  const body = ai
    ? renderMarkdown(message.text, Math.max(4, width - 2))
    : wrapText(message.text, Math.max(4, width - 6)).map((text) =>
        line(`    ${text}`, { fg: system ? theme.muted : theme.text }),
      );
  return [line(header, { fg: color, bold: !system }), ...body, line("")];
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
        `  ${workingFrame(animationFrame)} Working · ${elapsed}s${detail && detail !== lastToolLabel ? ` · ${detail}` : ""}`,
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
    line("  ◫ Shared tasks", { fg: theme.amber, bold: true }),
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
    line("  Ctrl-O topics · Ctrl-P/N previous/next topic · Ctrl-C twice to quit"),
    line(""),
    line("  Commands", { fg: theme.cyan, bold: true }),
    line("  /new  /topic  /topics  /delete  /copy"),
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
      item.authorId !== "system",
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

function topicOverlayLines(state: AppState, animationFrame = 0): UiLine[] {
  return [
    line("  Topics", { fg: theme.accent, bold: true }),
    line("  ↑↓ select · Enter open · N new · D/Del delete · Esc close", { fg: theme.muted }),
    line(""),
    ...state.topics.map((topic, index) => {
      const selected = index === state.topicPickerIndex;
      const running = state.activity[topic.id]?.running;
      return line(
        `  ${selected ? "›" : " "} ${running ? workingFrame(animationFrame) : "○"} ${topic.title}  ·  ${topic.agent ?? "no agent"}  ·  ${effectiveTopicModel(topic)}`,
        {
          fg: selected ? theme.text : running ? theme.green : theme.muted,
          bg: selected ? theme.selected : theme.canvas,
          bold: selected,
        },
      );
    }),
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
    (item) => !item.id.startsWith("tasks-") && item.kind !== "system" && item.authorId !== "system",
  )) {
    all.push(...messageLines(message, width, state.userId, state.aiName));
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
  if (state.overlay === "topics") return topicOverlayLines(state, animationFrame).slice(0, height);
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

function inputVisualLines(state: AppState, width: number): UiLine[] {
  if (!state.input) {
    return [
      line("  › █ Type a message or /command…", { fg: theme.subtle, bg: theme.surfaceRaised }),
    ];
  }
  const contentWidth = Math.max(4, width - 5);
  const result: UiLine[] = [];
  for (const [row, inputLine] of state.input.split("\n").entries()) {
    const points = Array.from(inputLine);
    const marked =
      row === state.inputCursor.row
        ? `${points.slice(0, state.inputCursor.col).join("")}█${points.slice(state.inputCursor.col).join("")}`
        : inputLine;
    for (const [visualIndex, wrapped] of wrapText(marked, contentWidth).entries()) {
      result.push(
        line(`${row === 0 && visualIndex === 0 ? "  › " : "    "}${wrapped}`, {
          bg: theme.surfaceRaised,
        }),
      );
    }
  }
  return result;
}

function composerPane(state: AppState, width: number): string[] {
  const title = state.input.startsWith("/new ")
    ? "new topic · type <name> [agent] · Enter create"
    : "Ctrl-O topics";
  const inputLines = inputVisualLines(state, width).slice(-5);
  const suggestions = commandSuggestions(state.input);
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
  return state.input.startsWith("/new ") ? [hint, ...input] : [...input, hint];
}

function footerLines(
  state: AppState,
  width: number,
  animationFrame = 0,
  nowMs = terminalNowMs(),
): string[] {
  const topic = activeTopic(state);
  const activity = topic ? state.activity[topic.id] : undefined;
  const status = activity?.running
    ? `${workingFrame(animationFrame)} Working · ${workingElapsedSeconds(activity.startedAtMs, nowMs)}s`
    : "○ ready";
  return [
    paint(
      joinSides(
        `  ${topic?.title ?? "no topic"} · ${topic?.agent ?? "-"} · ${effectiveTopicModel(topic)}`,
        `${status}  `,
        width,
      ),
      {
        fg: activity?.running ? theme.green : theme.accent,
        bg: theme.surfaceRaised,
        bold: true,
      },
    ),
    paint(joinSides("", state.notice ? `! ${state.notice}  ` : "Ctrl-C twice to quit  ", width), {
      fg: state.notice ? theme.amber : theme.muted,
      bg: theme.canvas,
    }),
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
  const width = Math.max(32, columns);
  const height = Math.max(14, rows);
  const footer = footerLines(state, width, animationFrame, nowMs);
  const decision = decisionPane(state, width);
  const composer = composerPane(state, width);
  const bodyHeight = Math.max(3, height - footer.length - decision.length - composer.length);
  const body = renderBody(
    conversationLines(state, width, bodyHeight, animationFrame, nowMs),
    width,
    bodyHeight,
  );
  return [...body, ...decision, ...composer, ...footer].slice(0, height).join("\n");
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
      composerPane(state, width).length,
  );
  const lineCount = conversationContentLines(state, width).length;
  return conversationViewport(lineCount, bodyHeight, state.scrollOffset).maxOffset;
}
