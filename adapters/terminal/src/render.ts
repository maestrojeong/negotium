import type { MessageDto } from "@negotium/core";
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
  // biome-ignore lint/complexity/useRegexLiterals: a string pattern avoids embedding control characters in source.
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
  const clean = safeText(value).replace(/\n/g, " ");
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
    let line = "";
    let lineWidth = 0;
    for (const char of [...paragraph]) {
      const charWidth = runeWidth(char);
      if (lineWidth + charWidth > width && line) {
        output.push(line);
        line = "";
        lineWidth = 0;
      }
      line += char;
      lineWidth += charWidth;
    }
    output.push(line);
  }
  return output.length > 0 ? output : [""];
}

function line(value: string, options: Omit<UiLine, "text"> = {}): UiLine {
  return { text: value, ...options };
}

function framePane(
  title: string,
  content: UiLine[],
  width: number,
  height: number,
  options: { active?: boolean; accent?: Rgb } = {},
): string[] {
  if (width < 4 || height < 2) {
    return Array.from({ length: height }, () =>
      paint(" ".repeat(Math.max(0, width)), { bg: theme.canvas }),
    );
  }
  const innerWidth = width - 2;
  const borderColor = options.active ? (options.accent ?? theme.borderActive) : theme.border;
  const label = ` ${sliceWidth(title, Math.max(0, innerWidth - 3))} `;
  const topPlain = `╭${label}${"─".repeat(Math.max(0, innerWidth - displayWidth(label)))}╮`;
  const top = paint(topPlain, {
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

function timestamp(message: MessageDto): string {
  const date = new Date(message.createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function messageLines(message: MessageDto, width: number, userId: string): UiLine[] {
  const own = message.authorId === userId;
  const ai = message.authorId === "ai";
  const name = own ? "YOU" : ai ? (message.agentType ?? "AGENT").toUpperCase() : "SYSTEM";
  const color = own ? theme.cyan : ai ? theme.accent : theme.muted;
  const icon = own ? "◆" : ai ? "✦" : message.kind === "subagent" ? "↳" : "•";
  const header = joinSides(` ${icon}  ${name}`, timestamp(message), width);
  const bodyWidth = Math.max(8, width - 4);
  const body = wrapText(message.text, bodyWidth).map((text) =>
    line(`  ┃ ${text}`, { fg: theme.text, bg: theme.surfaceRaised }),
  );
  return [line(header, { fg: color, bold: true }), ...body, line("")];
}

function helpLines(): UiLine[] {
  return [
    line("  KEYBOARD", { fg: theme.accent, bold: true }),
    line(""),
    line("  Enter          send message / confirm decision"),
    line("  Ctrl-P / Ctrl-N previous / next topic"),
    line("  ↑ / ↓          select decision option"),
    line("  PgUp / PgDn    scroll conversation"),
    line("  Ctrl-X         abort active turn"),
    line("  Ctrl-O         topic switcher"),
    line("  Ctrl-C         quit cleanly"),
    line(""),
    line("  COMMANDS", { fg: theme.cyan, bold: true }),
    line("  /new <name> [agent]    /topic <name>"),
    line("  /abort  /topics  /help  /quit", { fg: theme.muted }),
  ];
}

function conversationLines(state: AppState, width: number, height: number): UiLine[] {
  if (state.overlay === "help") return helpLines().slice(0, height);
  if (state.overlay === "topics") {
    return [
      line("  SWITCH TOPIC", { fg: theme.accent, bold: true }),
      line(""),
      ...state.topics.map((topic, index) =>
        line(
          `  ${topic.id === state.activeTopicId ? "●" : "○"}  ${index + 1}. ${topic.title}   ${topic.agent ?? "no-agent"}`,
          {
            fg: topic.id === state.activeTopicId ? theme.text : theme.muted,
            bg: topic.id === state.activeTopicId ? theme.selected : theme.surface,
            bold: topic.id === state.activeTopicId,
          },
        ),
      ),
      line(""),
      line("  Ctrl-P / Ctrl-N to move · Esc to close", {
        fg: theme.subtle,
      }),
    ].slice(0, height);
  }

  const all: UiLine[] = [];
  const messages = activeMessages(state).filter((message) => !message.id.startsWith("tasks-"));
  for (const message of messages) {
    all.push(...messageLines(message, width, state.userId));
  }
  if (all.length === 0) {
    all.push(
      line(""),
      line("        ✦", { fg: theme.accent, bold: true }),
      line("  Start a conversation", { fg: theme.text, bold: true }),
      line("  Ask, build, research, or delegate from the composer below.", {
        fg: theme.muted,
      }),
    );
  }
  const maxOffset = Math.max(0, all.length - height);
  const offset = Math.min(maxOffset, state.scrollOffset);
  const end = all.length - offset;
  return all.slice(Math.max(0, end - height), end);
}

function topicLines(state: AppState, height: number): UiLine[] {
  const activeIndex = Math.max(
    0,
    state.topics.findIndex((topic) => topic.id === state.activeTopicId),
  );
  const start = Math.max(0, activeIndex - Math.floor(height / 2));
  return state.topics.slice(start, start + height).map((topic) => {
    const selected = topic.id === state.activeTopicId;
    const running = state.activity[topic.id]?.running;
    return line(` ${selected ? "▸" : " "} ${running ? "●" : "○"} ${topic.title}`, {
      fg: selected ? theme.text : running ? theme.green : theme.muted,
      bg: selected ? theme.selected : theme.surface,
      bold: selected,
    });
  });
}

function activityLines(state: AppState, height: number): UiLine[] {
  const topic = activeTopic(state);
  if (!topic) return [line("  No active topic", { fg: theme.muted })];
  const activity = state.activity[topic.id] ?? { running: false, tools: [] };
  const lines: UiLine[] = [
    line(activity.running ? "  ●  RUNNING" : "  ○  READY", {
      fg: activity.running ? theme.green : theme.muted,
      bold: true,
    }),
    line(`  ${activity.status ?? "Waiting for input"}`, { fg: theme.muted }),
  ];
  if (activity.error) {
    lines.push(line(`  ! ${activity.error}`, { fg: theme.red }));
  }
  if (activity.tools.length > 0) {
    lines.push(line(""), line("  RECENT TOOLS", { fg: theme.cyan, bold: true }));
    for (const tool of activity.tools.slice(-4)) {
      lines.push(
        line(`  ${tool.status === "done" ? "✓" : "↻"}  ${tool.label}`, {
          fg: tool.status === "done" ? theme.green : theme.text,
        }),
      );
    }
  }
  const taskPanel = activeTaskPanel(state);
  if (taskPanel) {
    lines.push(line(""), line("  SHARED TASKS", { fg: theme.amber, bold: true }));
    for (const taskLine of safeText(taskPanel.text).split("\n").slice(1)) {
      lines.push(line(`  ${taskLine.trimStart()}`, { fg: theme.text }));
    }
  }
  return lines.slice(0, height);
}

function decisionPane(state: AppState, width: number): string[] {
  const ask = activeQuestion(state);
  const question = ask?.askUserQuestion;
  if (!ask || !question?.choices.length) return [];
  const selected = Math.min(state.askChoiceIndex, question.choices.length - 1);
  const content: UiLine[] = [
    line(`  ${question.question}`, { fg: theme.text, bold: true }),
    ...question.choices.map((choice, index) =>
      line(
        `  ${index === selected ? "●" : "○"}  ${choice.label}${choice.description ? ` — ${choice.description}` : ""}`,
        {
          fg: index === selected ? theme.text : theme.muted,
          bg: index === selected ? theme.selected : theme.surface,
          bold: index === selected,
        },
      ),
    ),
  ];
  const height = Math.min(8, Math.max(4, content.length + 2));
  return framePane("decision required  ·  ↑↓ select  ·  enter confirm", content, width, height, {
    active: true,
    accent: theme.amber,
  });
}

function composerPane(state: AppState, width: number): string[] {
  const topic = activeTopic(state);
  const activity = topic ? state.activity[topic.id] : undefined;
  const label = activity?.running
    ? "working  ·  type to supersede  ·  ctrl-x abort"
    : "message  ·  enter send  ·  ctrl-o topics  ·  /help";
  const placeholder = state.input ? `  ❯  ${state.input}█` : "  ❯  Type a message or /command…█";
  return framePane(
    label,
    [
      line(placeholder, {
        fg: state.input ? theme.text : theme.subtle,
        bg: theme.surfaceRaised,
      }),
    ],
    width,
    3,
    { active: true },
  );
}

function headerLines(state: AppState, width: number): string[] {
  const topic = activeTopic(state);
  const activity = topic ? state.activity[topic.id] : undefined;
  const status = activity?.running ? "● RUNNING" : "○ READY";
  const first = joinSides("  ◆  NEGOTIUM  /  TERMINAL", `${status}  LOCAL RUNTIME  `, width);
  const breadcrumb = `  ${topic?.title ?? "NO TOPIC"}  /  ${(topic?.agent ?? "-").toUpperCase()}  ·  ${topic?.defaultModel ?? "-"}`;
  const notice = state.notice ? `! ${state.notice}  ` : "Ctrl-C quit  ";
  return [
    paint(first, {
      fg: activity?.running ? theme.green : theme.accent,
      bg: theme.surfaceRaised,
      bold: true,
    }),
    paint(joinSides(breadcrumb, notice, width), {
      fg: state.notice ? theme.amber : theme.muted,
      bg: theme.canvas,
    }),
  ];
}

export function renderApp(state: AppState, columns: number, rows: number): string {
  const width = Math.max(32, columns);
  const height = Math.max(14, rows);
  const header = headerLines(state, width);
  const decision = decisionPane(state, width);
  const composer = composerPane(state, width);
  const bodyHeight = Math.max(3, height - header.length - decision.length - composer.length);
  const wide = width >= 104;
  let body: string[];

  if (wide) {
    const gapWidth = 1;
    const leftWidth = Math.min(24, Math.max(21, Math.floor(width * 0.19)));
    const rightWidth = Math.min(32, Math.max(27, Math.floor(width * 0.24)));
    const centerWidth = width - leftWidth - rightWidth - gapWidth * 2;
    const left = framePane(
      "topics  ·  ctrl-p / ctrl-n",
      topicLines(state, bodyHeight - 2),
      leftWidth,
      bodyHeight,
    );
    const center = framePane(
      "conversation",
      conversationLines(state, centerWidth - 2, bodyHeight - 2),
      centerWidth,
      bodyHeight,
      { active: true },
    );
    const right = framePane(
      "activity",
      activityLines(state, bodyHeight - 2),
      rightWidth,
      bodyHeight,
    );
    const gap = paint(" ".repeat(gapWidth), { bg: theme.canvas });
    body = Array.from(
      { length: bodyHeight },
      (_, index) => `${left[index]}${gap}${center[index]}${gap}${right[index]}`,
    );
  } else {
    body = framePane(
      activeTopic(state)?.title ?? "conversation",
      conversationLines(state, width - 2, bodyHeight - 2),
      width,
      bodyHeight,
      { active: true },
    );
  }

  const rendered = [...header, ...body, ...decision, ...composer];
  return rendered.slice(0, height).join("\n");
}
