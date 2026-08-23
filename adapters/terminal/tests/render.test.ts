import { beforeEach, describe, expect, test } from "bun:test";
import type { MessageDto, TopicDto } from "@negotium/core";
import { terminalNowMs } from "@/clock";
import { activeContextBreakdown } from "@/context-usage";
import {
  clearMessageLayoutCache,
  displayWidth,
  effectiveTopicModel,
  formatElapsedDuration,
  maxConversationScrollOffset,
  preserveConversationScrollAnchor,
  renderApp,
  renderAppFrame,
  setColorDepth,
  stripAnsi,
  WORKING_FRAME_INTERVAL_MS,
  workingFrame,
  wrapText,
} from "@/render";
import { highlightScreenSelection } from "@/selection";
import {
  applyRuntimeEvent,
  createInitialState,
  openTopicPicker,
  setMessages,
  setTopicFilter,
  setTopics,
  setTopicUsage,
  upsertMessage,
} from "@/state";

// The renderer defaults to `none` when stdout is not a TTY, which is exactly
// the case under `bun test`. These suites assert on concrete escape bytes, so
// they pin the depth explicitly; the `NO_COLOR` / downshift behaviour is
// covered separately in `color-depth.test.ts` and in the plain-text suite here.
beforeEach(() => {
  setColorDepth("truecolor");
});

describe("notice severity", () => {
  const ESC = String.fromCharCode(0x1b);
  const MARKERS = [
    ["success", "✓", `${ESC}[38;2;94;211;142m`],
    ["error", "✗", `${ESC}[38;2;245;116;128m`],
    ["warn", "!", `${ESC}[38;2;241;190;91m`],
    ["info", "·", `${ESC}[38;2;137;141;158m`],
  ] as const;

  function noticed(
    level: "info" | "success" | "warn" | "error",
    text: string,
    columns = 80,
  ): string {
    const state = setTopics(createInitialState("local"), [topic()]);
    return renderApp({ ...state, notice: text, noticeLevel: level }, columns, 16);
  }

  for (const [level, glyph, colour] of MARKERS) {
    test(`renders ${level} with its own glyph and colour`, () => {
      const frame = noticed(level, `${level} happened`);
      expect(stripAnsi(frame)).toContain(`${glyph} ${level} happened`);
      expect(frame).toContain(colour);
    });
  }

  test("falls back to the pre-severity warn styling when no level is set", () => {
    const state = setTopics(createInitialState("local"), [topic()]);
    const frame = renderApp({ ...state, notice: "unclassified" }, 80, 16);
    expect(stripAnsi(frame)).toContain("! unclassified");
    expect(frame).toContain(`${ESC}[38;2;241;190;91m`);
  });

  test("every severity glyph measures exactly one column", () => {
    // A two-column glyph here would push the footer past the terminal width and
    // desynchronise every physical row below it.
    for (const [, glyph] of MARKERS) expect(displayWidth(glyph)).toBe(1);
  });

  test("keeps the footer within the terminal width on narrow terminals", () => {
    for (const [level] of MARKERS) {
      for (const columns of [10, 20, 32, 44]) {
        const frame = noticed(level, "a notice long enough to need clipping", columns);
        for (const row of frame.split("\n")) {
          expect(displayWidth(row)).toBeLessThanOrEqual(columns);
        }
      }
    }
  });
});

function topic(): TopicDto {
  return {
    id: "topic",
    title: "Terminal",
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt",
    defaultEffort: "medium",
    participants: [{ userId: "local", role: "owner" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("terminal renderer", () => {
  test("uses wall time compatible with persisted runtime-event timestamps", () => {
    expect(Math.abs(terminalNowMs() - Date.now())).toBeLessThan(50);
  });

  test("formats working time with day, hour, minute, and second units", () => {
    expect(formatElapsedDuration(0)).toBe("0s");
    expect(formatElapsedDuration(45)).toBe("45s");
    expect(formatElapsedDuration(451)).toBe("7m 31s");
    expect(formatElapsedDuration(3_605)).toBe("1h 0m 5s");
    expect(formatElapsedDuration(93_784)).toBe("1d 2h 3m 4s");
  });

  test("counts Korean glyphs as wide characters", () => {
    expect(displayWidth("a한")).toBe(3);
    expect(wrapText("가나다", 4)).toEqual(["가나", "다"]);
  });

  test("positions the hardware cursor after wide Korean glyphs", () => {
    const state = {
      ...createInitialState("local"),
      input: "가나다",
      inputCursor: { row: 0, col: 1 },
    };
    const rendered = renderAppFrame(state, 80, 24);
    const cursor = rendered.cursor;

    expect(cursor).not.toBeNull();
    expect(cursor?.x).toBe(7);
    expect(stripAnsi(rendered.frame).split("\n")[Number(cursor?.y) - 1]).toContain("  › 가나다");
    expect(rendered.frame).not.toContain("█");
  });

  test("fills exactly the requested terminal height", () => {
    const output = renderApp(createInitialState("local"), 120, 30);
    expect(output.split("\n")).toHaveLength(30);
  });

  test("shows Vault entries with set and del command guidance", () => {
    const state = {
      ...createInitialState("local"),
      overlay: "vault" as const,
      vaultEntries: [
        { key: "API_TOKEN", description: "primary" },
        { key: "SIGNING_KEY", description: "release" },
      ],
      vaultPickerIndex: 1,
    };
    const output = stripAnsi(renderApp(state, 80, 22));

    expect(output).toContain("Encrypted locally");
    expect(output).toContain("API_TOKEN  primary");
    expect(output).toContain("• SIGNING_KEY  release");
    expect(output).toContain("/vault set KEY VALUE | optional description");
    expect(output).toContain("Example: /vault set GITHUB_TOKEN your-secret-value | GitHub access");
    expect(output).toContain("/vault del KEY");
    expect(output).toContain("Example: /vault del GITHUB_TOKEN");
    expect(output).toContain("Type /vault set … or /vault del …");
    expect(output).not.toContain("N add");
  });

  test("masks Vault secret input while preserving the cursor position", () => {
    const state = {
      ...createInitialState("local"),
      overlay: "vault" as const,
      vaultMode: "value" as const,
      vaultDraftKey: "API_TOKEN",
      input: "super-secret",
      inputCursor: { row: 0, col: 12 },
    };
    const rendered = renderAppFrame(state, 80, 18);
    const output = stripAnsi(rendered.frame);

    expect(output).toContain("************");
    expect(output).not.toContain("super-secret");
    expect(output).toContain("secret value · Enter continue · Esc cancel");
    expect(rendered.cursor?.x).toBe(17);
  });

  test("keeps the always-active message composer flat and borderless", () => {
    const output = stripAnsi(renderApp(createInitialState("local"), 120, 30));
    const lines = output.split("\n");
    const labelIndex = lines.findIndex((line) => line.includes("Ctrl-O topics"));
    expect(output).toContain("Ctrl-O topics");
    expect(output).not.toContain("Enter send");
    expect(output).not.toContain("Ctrl-J");
    expect(output).not.toContain("╭ message");
    expect(output).not.toContain("╰");
    expect(lines[labelIndex - 3]?.trim()).toBe("");
    expect(lines[labelIndex - 2]).toContain("Type a message");
    expect(lines[labelIndex - 1]?.trim()).toBe("");
  });

  test("scrolls slash command suggestions to keep the keyboard selection visible", () => {
    const output = stripAnsi(
      renderApp(
        {
          ...createInitialState("local"),
          input: "/",
          inputCursor: { row: 0, col: 1 },
          suggestionIndex: 8,
        },
        100,
        24,
      ),
    );

    expect(output).toContain("› /spawn");
    expect(output).not.toContain("/new  reset the current session");
  });

  test("shows a dedicated topic-name composer after choosing new topic", () => {
    const previousMessage: MessageDto = {
      id: "previous-message",
      topicId: "topic",
      authorId: "ai",
      text: "existing topic conversation",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [previousMessage]);
    state = { ...state, creatingTopic: true };
    const output = stripAnsi(renderApp(state, 120, 30));

    expect(output).toContain("new topic · type a name · Enter create");
    expect(output).toContain("Type a topic name…");
    expect(output).toContain("New topic");
    expect(output).toContain("○ naming");
    expect(output).not.toContain("existing topic conversation");
    expect(output).not.toContain("Terminal · codex · gpt");
    expect(output).not.toContain("/new ");
  });

  test("places topic metadata below the composer without duplicating live status", () => {
    const state = setTopics(createInitialState("local"), [topic()]);
    const output = stripAnsi(renderApp(state, 120, 30));
    const lines = output.split("\n");
    const composerIndex = lines.findIndex((line) => line.includes("Type a message"));
    const statusIndex = lines.findIndex((line) => line.includes("codex · gpt · medium"));

    expect(statusIndex).toBeGreaterThan(composerIndex);
    expect(lines[statusIndex]).not.toContain("ready");
    expect(lines[statusIndex]).not.toContain("Working");
    expect(output).not.toContain("NEGOTIUM");
  });

  test("does not display a stale Maestro model after switching the topic to Codex", () => {
    const stale = { ...topic(), defaultModel: "deepseek-pro" };
    expect(effectiveTopicModel(stale)).toBe("gpt-5.6-luna");

    const state = setTopics(createInitialState("local"), [stale]);
    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("codex · gpt-5.6-luna · medium");
    expect(output).not.toContain("codex · deepseek-pro");
  });

  test("shows the persisted per-topic model override in the footer", () => {
    const configured = { ...topic(), effectiveModel: "gpt-5.6-sol" };
    expect(effectiveTopicModel(configured)).toBe("gpt-5.6-sol");

    const state = setTopics(createInitialState("local"), [configured]);
    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("codex · gpt-5.6-sol · medium");
  });

  test("shows the active topic title in the footer", () => {
    const current = { ...topic(), title: "Release Planning" };
    const state = setTopics(createInitialState("local"), [current]);
    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Release Planning · codex ·");
  });

  test("shows current context and exact topic totals in the conversation footer", () => {
    const message: MessageDto = {
      id: "usage-footer-message",
      topicId: "topic",
      authorId: "ai",
      text: "done",
      usage: {
        input: 200,
        output: 30,
        cachedInput: 150,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const withMessages = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
      message,
    ]);
    const state = setTopicUsage(withMessages, {
      topicId: "topic",
      inputTokens: 12_300,
      outputTokens: 4_500,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 90_000,
      queries: 8,
      estimatedCostUsd: 1.25,
      currentSession: {
        timestamp: "2026-01-01T00:00:00.000Z",
        topicId: "topic",
        topicTitle: "Terminal",
        agent: "codex",
        model: "gpt",
        contextTokens: 104_464,
        contextWindow: 258_400,
      },
    });

    const wide = stripAnsi(renderApp(state, 140, 30));
    expect(wide).toContain("104k/258k 40%");
    expect(wide).not.toContain("ctx 104k");
    expect(wide).toContain("Σ 12.3k in/4.5k out");
    expect(wide).toContain("cache 90.0k");
    expect(wide).toContain("est $1.25");

    for (const row of renderApp(state, 44, 20).split("\n")) {
      expect(displayWidth(row)).toBeLessThanOrEqual(44);
    }
  });

  test("does not reuse message context after loaded stats report no active session", () => {
    const message: MessageDto = {
      id: "stale-session-usage",
      topicId: "topic",
      authorId: "ai",
      text: "pre-compact answer",
      usage: { input: 190_000, output: 2_000, context: 192_000, contextWindow: 200_000 },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const withMessages = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
      message,
    ]);

    expect(activeContextBreakdown(withMessages)?.context).toBe(192_000);

    const loaded = setTopicUsage(withMessages, {
      topicId: "topic",
      inputTokens: 190_000,
      outputTokens: 2_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      queries: 1,
      estimatedCostUsd: 1,
    });
    expect(activeContextBreakdown(loaded)).toBeUndefined();
    expect(stripAnsi(renderApp(loaded, 140, 30))).not.toContain("192k/200k 96%");
  });

  test("uses neutral, warning, and critical colours for context usage", () => {
    const ESC = String.fromCharCode(0x1b);
    const colours = [
      [40_000, 40, `${ESC}[38;2;232;233;239m`],
      [85_000, 85, `${ESC}[38;2;241;190;91m`],
      [95_000, 95, `${ESC}[38;2;245;116;128m`],
    ] as const;

    for (const [contextTokens, percent, colour] of colours) {
      const state = setTopicUsage(setTopics(createInitialState("local"), [topic()]), {
        topicId: "topic",
        inputTokens: 12_000,
        outputTokens: 2_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 8_000,
        queries: 1,
        estimatedCostUsd: 0.25,
        currentSession: {
          timestamp: "2026-01-01T00:00:00.000Z",
          topicId: "topic",
          topicTitle: "Terminal",
          agent: "codex",
          model: "gpt",
          contextTokens,
          contextWindow: 100_000,
        },
      });

      const frame = renderApp(state, 140, 30);
      const footer = frame.split("\n").find((row) => stripAnsi(row).includes(`${percent}%`));
      expect(footer).toContain(colour);
      expect(footer).toContain(`${ESC}[38;2;137;141;158m`);

      const status = renderApp({ ...state, overlay: "status" }, 100, 30);
      const contextLine = status
        .split("\n")
        .find((row) => stripAnsi(row).includes(`(${percent}%)`));
      expect(contextLine).toContain(colour);
    }
  });

  test("updates the footer and context breakdown from live stream progress", () => {
    const confirmed: MessageDto = {
      id: "confirmed",
      topicId: "topic",
      authorId: "ai",
      text: "previous answer",
      usage: {
        input: 100_000,
        output: 500,
        context: 100_000,
        contextWindow: 200_000,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const user: MessageDto = {
      id: "user",
      topicId: "topic",
      authorId: "local",
      text: "hello",
      createdAt: "2026-01-01T00:01:00.000Z",
    };
    let state = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
      confirmed,
      user,
    ]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "ai_active", queryId: "live" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "context_progress",
        queryId: "live",
        assistantTokens: 500,
        toolTokens: 1_000,
      },
    });

    const footer = stripAnsi(renderApp(state, 140, 30));
    expect(footer).toContain("~102k/200k 51%");

    const overlay = stripAnsi(renderApp({ ...state, overlay: "context" }, 100, 30));
    expect(overlay).toContain("Estimated    ~102k / 200k (51%)");
    expect(overlay).toContain("Confirmed    100k");
    expect(overlay).toContain("New user     6");
    expect(overlay).toContain("Assistant    500");
    expect(overlay).toContain("Tools        1.0k");
    expect(overlay).toContain("Free         98.5k");
    expect(overlay).toContain("System prompt and tool schemas are included in Confirmed");
  });

  test("does not present missing topic history as zero usage", () => {
    const state = setTopicUsage(setTopics(createInitialState("local"), [topic()]), {
      topicId: "topic",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      queries: 0,
      estimatedCostUsd: 0,
      currentSession: {
        timestamp: "2026-01-01T00:00:00.000Z",
        topicId: "topic",
        topicTitle: "Terminal",
        agent: "codex",
        model: "gpt",
        contextTokens: 20_000,
        contextWindow: 200_000,
      },
    });

    const footer = stripAnsi(renderApp(state, 120, 30));
    expect(footer).toContain("20.0k/200k 10%");
    expect(footer).not.toContain("Σ 0 in/0 out");
    expect(footer).not.toContain("est $0.00");

    const status = stripAnsi(renderApp({ ...state, overlay: "status" }, 120, 30));
    expect(status).toContain("Queries     unavailable");
    expect(status).toContain("Est. cost   unavailable");
  });

  test("shows both the agent and effective model in the topic picker", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Terminal  ·  codex  ·  gpt  ·  medium");
    expect(output).toContain("Ctrl-C exit; work continues");
  });

  test("groups manager rooms above the rest under one Topics heading", () => {
    const general = {
      ...topic(),
      id: "general",
      title: "General",
      kind: "manager" as const,
    };
    const work = { ...topic(), id: "work", title: "Work" };
    const other = { ...topic(), id: "other", title: "Other" };
    const state = {
      ...setTopics(createInitialState("local"), [work, other, general]),
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("  Manager");
    expect(output).toContain("  Topics");
    // Public/Private is gone with access mode: a terminal client only ever
    // lists its own surface, so there is nothing left to split the list by.
    expect(output).not.toContain("  Private");
    expect(output).not.toContain("  Public");
    // `lastIndexOf`: the overlay's own title line is also "Topics", so the
    // group heading is the second occurrence.
    expect(output.indexOf("  Manager")).toBeLessThan(output.indexOf("○ General"));
    expect(output.indexOf("○ General")).toBeLessThan(output.lastIndexOf("  Topics"));
    expect(output.lastIndexOf("  Topics")).toBeLessThan(output.indexOf("○ Work"));
  });

  test("shows active Cron, Memory, and Compact sessions in read-only groups", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      backgroundSessions: [
        {
          id: "memory-1",
          kind: "memory" as const,
          title: "Archive Research",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "Tool: wiki_save",
          steps: ["Preparing archived conversation"],
        },
        {
          id: "cron-1",
          kind: "cron" as const,
          title: "Daily digest",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "Running",
          steps: [],
        },
        {
          id: "compact-1",
          kind: "compact" as const,
          title: "Compact Research",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "Summarizing",
          steps: ["Provider session started"],
        },
      ],
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Memory");
    expect(output).toContain("Archive Research  ·  Tool: wiki_save");
    expect(output).toContain("Cron");
    expect(output).toContain("Daily digest  ·  Running");
    expect(output).toContain("Compact");
    expect(output).toContain("Compact Research  ·  Summarizing");
    expect(output.indexOf("Daily digest")).toBeLessThan(output.indexOf("Archive Research"));
    expect(output.indexOf("Archive Research")).toBeLessThan(output.indexOf("Compact Research"));
  });

  test("renders a compact background session with ephemeral lifecycle copy", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      backgroundSessions: [
        {
          id: "compact-1",
          kind: "compact" as const,
          title: "Compact Research",
          startedAt: new Date().toISOString(),
          status: "Summarizing",
          agent: "maestro" as const,
          model: "deepseek-pro",
          effort: "low" as const,
          steps: [
            "Reasoning: selecting the relevant implementation details and unresolved verification work from a long transcript",
          ],
        },
      ],
      topicPickerBackgroundId: "compact-1",
      overlay: "background-session" as const,
    };

    const output = stripAnsi(renderAppFrame(state, 72, 30).frame);
    const compactOutput = output.replace(/\s/g, "");
    expect(output).toContain("Compact · read-only");
    expect(output).toContain("completed logs remain available for 5 minutes");
    expect(compactOutput).toContain(
      "Reasoning:selectingtherelevantimplementationdetailsandunresolvedverificationworkfromalongtranscript",
    );
  });

  test("renders a background session without an interactive composer", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      backgroundSessions: [
        {
          id: "memory-1",
          kind: "memory" as const,
          title: "Archive Research",
          startedAt: new Date().toISOString(),
          status: "Writing topic brief",
          agent: "claude" as const,
          model: "sonnet",
          steps: ["Tool: wiki_save"],
        },
      ],
      topicPickerBackgroundId: "memory-1",
      overlay: "background-session" as const,
    };

    const rendered = renderAppFrame(state, 120, 30);
    const output = stripAnsi(rendered.frame);
    expect(output).toContain("Memory · read-only");
    expect(output).toContain("Tool: wiki_save");
    expect(output).not.toContain("Ctrl-O topics");
    // A read-only overlay has no text entry at all, so no caret either.
    expect(rendered.cursor).toBeNull();
  });

  test("renders complete background output and scrolls to earlier activity", () => {
    const outputLines = Array.from({ length: 30 }, (_, index) => `Output line ${index + 1}`).join(
      "\n",
    );
    const base = {
      ...setTopics(createInitialState("local"), [topic()]),
      backgroundSessions: [
        {
          id: "memory-scroll",
          kind: "memory" as const,
          title: "Archive Research",
          startedAt: new Date().toISOString(),
          status: "Completed",
          active: false,
          output: outputLines,
          steps: Array.from({ length: 12 }, (_, index) => `Activity ${index + 1}`),
        },
      ],
      topicPickerBackgroundId: "memory-scroll",
      overlay: "background-session" as const,
    };

    const latest = stripAnsi(renderAppFrame(base, 72, 20).frame);
    expect(latest).toContain("Output line 30");
    expect(latest).not.toContain("Activity 1");

    const maxOffset = maxConversationScrollOffset(base, 72, 20);
    const earlier = stripAnsi(
      renderAppFrame({ ...base, backgroundScrollOffset: maxOffset }, 72, 20).frame,
    );
    expect(maxOffset).toBeGreaterThan(0);
    expect(earlier).toContain("Start of background session");
    expect(earlier).toContain("Memory · read-only");
    expect(earlier).not.toContain("Output line 30");
  });

  test("keeps an idle Cron session readable with its prompt and execution config", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      backgroundSessions: [
        {
          id: "cron-topic-1",
          kind: "cron" as const,
          title: "Daily digest",
          startedAt: new Date().toISOString(),
          status: "Scheduled",
          active: false,
          agent: "codex" as const,
          model: "gpt",
          effort: "high" as const,
          prompt: "Summarize today's operational changes.",
          promptTitle: "Prompt · daily-digest",
          steps: ["Reasoning: selecting relevant changes", "Tool: wiki_query"],
        },
      ],
      topicPickerBackgroundId: "cron-topic-1",
      overlay: "background-session" as const,
    };

    const output = stripAnsi(renderAppFrame(state, 120, 30).frame);
    expect(output).toContain("session stays available between runs");
    expect(output).toContain("codex · gpt · high");
    expect(output).toContain("Prompt · daily-digest");
    expect(output).toContain("Summarize today's operational changes.");
    expect(output).toContain("Reasoning: selecting relevant changes");
    expect(output).not.toContain("Scheduled · 0s");
  });

  test("labels the startup topic picker as an exit screen instead of a closable overlay", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      activeTopicId: null,
      overlay: "topics" as const,
      topicPickerRoot: true,
      input: "stale chat draft",
      inputCursor: { row: 0, col: 16 },
    };

    const rendered = renderAppFrame(state, 120, 30);
    const output = stripAnsi(rendered.frame);
    expect(output).toContain("Esc/Ctrl-C exit");
    expect(output).not.toContain("Esc close");
    expect(output).not.toContain("stale chat draft");
    expect(output).not.toContain("Ctrl-O topics");
    // The picker is type-to-filter, so the caret belongs on the filter row even
    // before anything is typed — that is where a Hangul preedit has to anchor.
    expect(rendered.cursor).toEqual({ x: displayWidth("  Filter: ") + 1, y: 3 });
  });

  test("keeps the selected topic visible in a short grouped picker", () => {
    const topics = [
      { ...topic(), id: "general", title: "General", kind: "manager" as const },
      ...Array.from({ length: 9 }, (_, index) => ({
        ...topic(),
        id: `topic-${index}`,
        title: `Topic ${index}`,
      })),
    ];
    const state = {
      ...setTopics(createInitialState("local"), topics),
      overlay: "topics" as const,
      topicPickerIndex: 9,
    };

    const output = stripAnsi(renderApp(state, 80, 14));
    expect(output).toContain("› ○ Topic 8");
  });

  test("shows descriptions alongside model-only choices in the model picker", () => {
    const state = {
      ...setTopics(createInitialState("local"), [
        { ...topic(), defaultModel: "gpt-5.6-luna", effectiveModel: "gpt-5.6-luna" },
      ]),
      overlay: "models" as const,
      modelPickerIndex: 0,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Models");
    expect(output).toContain("gpt-5.6-luna (current)");
    const selected = output.split("\n").find((line) => line.includes("gpt-5.6-sol"));
    expect(selected).toContain("› gpt-5.6-sol");
    expect(selected).toContain(
      "Highest-capability Codex route for the hardest agentic coding work.",
    );
    expect(selected).not.toContain("codex");
    expect(output).toContain("Default Claude route for capable, efficient everyday work.");
    expect(output).toContain("API-priced Sonnet-level route for cost-efficient everyday work.");
    expect(output).toContain("deepseek-flash");
  });

  test("keeps the selected model visible in a short terminal", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      overlay: "models" as const,
      modelPickerIndex: 8,
    };

    const output = stripAnsi(renderApp(state, 80, 14));
    expect(output).toContain("› deepseek-pro");
  });

  test("shows all reasoning effort choices and marks the current value", () => {
    const state = {
      ...setTopics(createInitialState("local"), [
        { ...topic(), defaultEffort: "medium" as const, effectiveEffort: "high" as const },
      ]),
      overlay: "effort" as const,
      effortPickerIndex: 1,
    };

    const output = stripAnsi(renderApp(state, 80, 20));
    expect(output).toContain("Reasoning effort");
    expect(output).toContain("› medium");
    expect(output).toContain("high (current)");
    expect(output).toContain("xhigh");
    expect(output).toContain("max");
  });

  test("renders subagent ownership branches in the topic picker", () => {
    const parent = { ...topic(), id: "parent", title: "Parent" };
    const child = {
      ...topic(),
      id: "child",
      title: "Child",
      isSubagent: true,
      parentTopicId: parent.id,
    };
    const state = {
      ...setTopics(createInitialState("local"), [child, parent]),
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    const parentLine = output.split("\n").find((row) => row.includes("Parent"));
    const childLine = output.split("\n").find((row) => row.includes("Child"));

    expect(parentLine).not.toContain("└─");
    expect(childLine).toContain("└─ ○ Child");
    expect(output.indexOf("Parent")).toBeLessThan(output.indexOf("Child"));
    expect(output).not.toContain("SUBAGENT");
  });

  // The line-diff renderer maps logical line index directly onto physical
  // terminal rows. A single line wider than the reported column count
  // auto-wraps and desynchronises every row below it (and the IME cursor), so
  // the width invariant is asserted for every state the renderer can produce.
  describe("never renders a line wider than the terminal reports", () => {
    const widths = [1, 2, 3, 5, 8, 10, 12, 16, 20, 28, 31, 32, 33, 40, 44, 60, 80, 120, 200];

    /** What a Finder drag-and-drop actually pastes: macOS hands back NFD. */
    const DECOMPOSED_PATH = "'/Users/me/Desktop/스크린샷 2026-08-23 오전 7.16.37.png'".normalize(
      "NFD",
    );

    const longMessages: MessageDto[] = [
      {
        id: "cjk",
        topicId: "topic",
        authorId: "local",
        text: "한글 메시지가 아주 길어서 좁은 터미널에서 반드시 접혀야 하는 문장입니다 ✅ ￦1,000 🇰🇷",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "markdown",
        topicId: "topic",
        authorId: "ai",
        text: [
          "# Heading that is quite long indeed",
          "",
          "Body with **bold**, `code`, and a [link](https://example.com/very/long/path).",
          "",
          "| column one | column two | column three |",
          "| --- | ---: | :---: |",
          "| value aaaaaaaa | value bbbbbbbb | value cccccccc |",
          "",
          "```ts",
          "const someVeryLongIdentifier = doSomethingWithAVeryLongName(argument);",
          "```",
          "",
          "- bullet item that keeps going and going and going",
          "> quoted text that also keeps going and going",
        ].join("\n"),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "tool",
        topicId: "topic",
        authorId: "ai",
        kind: "tool",
        text: "Edit · /a/very/long/path/to/some/file.ts (+12 -3)\n+ added a long line of content here\n- removed a long line of content here",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "ask",
        topicId: "topic",
        authorId: "ai",
        kind: "ask_user_question",
        text: "question",
        askUserQuestion: {
          question: "Which deployment target should this very long question use?",
          choices: [
            { label: "production", description: "the real one, with a long description" },
            { label: "staging", description: "the safe one, also with a long description" },
          ],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ] as MessageDto[];

    const graphCanvasLines = [
      "╭──────────╮                   ",
      "│ ○ Root   │                   ",
      "╰──────────╯                   ",
      "     │                         ",
      "     ▼                         ",
      "                    ╭─────────╮",
      "                    │ ○ Child │",
      "                    ╰─BOTTOM──╯",
    ];

    const populated = setMessages(
      setTopics(createInitialState("local"), [topic()]),
      "topic",
      longMessages,
    );

    const scenarios: Record<string, ReturnType<typeof createInitialState>> = {
      empty: createInitialState("local"),
      "no topic with input": {
        ...createInitialState("local"),
        input: "안녕하세요 this is a fairly long draft message",
        inputCursor: { row: 0, col: 20 },
      },
      "conversation with decision overlay": populated,
      "conversation scrolled": { ...populated, scrollOffset: 5 },
      // Dropping a macOS file onto the terminal pastes an NFD path.
      "composer holding a decomposed Hangul path": {
        ...setTopics(createInitialState("local"), [topic()]),
        input: DECOMPOSED_PATH,
        inputCursor: { row: 0, col: [...DECOMPOSED_PATH].length },
      },
      "task sidebar": {
        ...setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
          {
            id: "tasks-1",
            topicId: "topic",
            authorId: "ai",
            text: "- [ ] first task with a long title\n- [x] ✅ second task done",
            createdAt: "2026-01-01T00:00:00.000Z",
          } as MessageDto,
        ]),
        taskSidebarEnabled: true,
      },
      "topic picker": openTopicPicker(setTopics(createInitialState("local"), [topic()])),
      // The filter row is new geometry in the picker, so it gets the full
      // width-vector treatment too rather than relying on the unfiltered
      // picker above to cover it.
      "topic picker filtered": setTopicFilter(
        openTopicPicker(setTopics(createInitialState("local"), [topic()])),
        "한글 섞인 아주 긴 필터 문자열 that also runs long in latin",
      ),
      "topic picker no matches": setTopicFilter(
        openTopicPicker(setTopics(createInitialState("local"), [topic()])),
        "zzz-nothing-matches-this",
      ),
      "creating topic": {
        ...setTopics(createInitialState("local"), [topic()]),
        creatingTopic: true,
        input: "a new topic name that is long",
        inputCursor: { row: 0, col: 5 },
      },
      help: { ...setTopics(createInitialState("local"), [topic()]), overlay: "help" as const },
      status: { ...setTopics(createInitialState("local"), [topic()]), overlay: "status" as const },
      "subagent graph": {
        ...setTopics(createInitialState("local"), [topic()]),
        overlay: "subagents" as const,
        subagentGraphLoading: false,
        subagentGraph: {
          title: "Root",
          rootDetail: "codex · gpt-5.6-luna · medium",
          rootRunning: false,
          nodes: [],
          edges: [],
          lines: graphCanvasLines,
          width: 31,
          height: graphCanvasLines.length,
        },
      },
      notice: { ...populated, notice: "Copy failed: ENOENT while writing to the clipboard" },
      // A tab-indented file (the common case for Go, or any tab-styled TS repo)
      // reaches the renderer verbatim inside an Edit preview. `displayWidth`
      // scores a tab as one column while the terminal advances to the next tab
      // stop, so an unexpanded tab silently overflows the conversation pane.
      "tab-indented tool diff beside the task sidebar": {
        ...setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
          {
            id: "tasks-tab",
            topicId: "topic",
            authorId: "ai",
            // First line is the panel header; `taskItems` slices it off.
            text: "Tasks\n- [ ] keep the sidebar aligned\n- [ ] and stay one column wide",
            createdAt: "2026-01-01T00:00:00.000Z",
          } as MessageDto,
          {
            id: "tool-tab",
            topicId: "topic",
            authorId: "ai",
            kind: "tool",
            text: [
              "Edit · /a/very/long/path/to/some/file.ts (+4 -1)",
              "296 +export function parseLegacyTellText(",
              "297 +\tvalue: unknown,",
              '298 +): Message["tellCard"] | undefined {',
              '299 +\t\tif (typeof value !== "string") return undefined;',
              "300 +\t\t\tconst patterns = [",
            ].join("\n"),
            createdAt: "2026-01-01T00:00:01.000Z",
          } as MessageDto,
        ]),
        taskSidebarEnabled: true,
      },
    };

    for (const [name, state] of Object.entries(scenarios)) {
      test(name, () => {
        for (const cols of widths) {
          const rendered = renderAppFrame(state, cols, 24);
          const rows = rendered.frame.split("\n");
          // codex asserts the exact vector of widths (PR #34775) rather than a
          // snapshot, because a reviewed snapshot can freeze a broken layout in
          // place. Every row is padded to the full width, so equality holds.
          const rowWidths = rows.map((row) => displayWidth(stripAnsi(row)));
          expect({ name, cols, rowWidths }).toEqual({
            name,
            cols,
            rowWidths: rows.map(() => cols),
          });
          if (rendered.cursor) expect(rendered.cursor.x).toBeLessThanOrEqual(cols);
        }
      });
    }

    // `displayWidth` is the renderer's own measure, so it cannot catch a tab:
    // it scores one column for a byte the terminal expands to the next tab
    // stop. The width vector above therefore passes on an over-wide row. This
    // asserts the property the terminal actually sees.
    test("emits no tab, so measured width matches what the terminal prints", () => {
      const TERMINAL_TAB_STOP = 8;
      const printedWidth = (row: string): number => {
        let columns = 0;
        for (const character of stripAnsi(row)) {
          columns =
            character === "\t"
              ? (Math.floor(columns / TERMINAL_TAB_STOP) + 1) * TERMINAL_TAB_STOP
              : columns + displayWidth(character);
        }
        return columns;
      };

      for (const [name, state] of Object.entries(scenarios)) {
        for (const cols of widths) {
          const rows = renderAppFrame(state, cols, 24).frame.split("\n");
          expect({ name, cols, tabs: rows.some((row) => row.includes("\t")) }).toEqual({
            name,
            cols,
            tabs: false,
          });
          expect({ name, cols, widths: rows.map(printedWidth) }).toEqual({
            name,
            cols,
            widths: rows.map(() => cols),
          });
        }
      }
    });

    // A decomposed path renders the same glyphs as the composed one, so the
    // frame and the hardware cursor must be byte-identical between the two.
    // Over-measuring the medial/final jamo pads the composer row short and
    // leaves the caret parked in the blank space past the text.
    test("renders a decomposed Hangul path exactly like the composed one", () => {
      const composed = DECOMPOSED_PATH.normalize("NFC");
      const stateFor = (input: string) => ({
        ...setTopics(createInitialState("local"), [topic()]),
        input,
        inputCursor: { row: 0, col: [...input].length },
      });

      for (const cols of [44, 80, 120]) {
        const nfd = renderAppFrame(stateFor(DECOMPOSED_PATH), cols, 24);
        const nfc = renderAppFrame(stateFor(composed), cols, 24);
        expect({ cols, cursor: nfd.cursor }).toEqual({ cols, cursor: nfc.cursor });
        expect({ cols, frame: stripAnsi(nfd.frame).normalize("NFC") }).toEqual({
          cols,
          frame: stripAnsi(nfc.frame),
        });
      }
    });

    // The sidebar is a per-row string concatenation of pane + gap + sidebar, so
    // an over-wide conversation row shifts that row's border and shreds the
    // pane. Asserting the border column is identical on every row catches the
    // tear directly, independent of how the row width was measured.
    test("keeps the task sidebar border in one column on every row", () => {
      const state = scenarios["tab-indented tool diff beside the task sidebar"];
      // Below TASK_SIDEBAR_MIN_WIDTH the panel renders inline and there is no
      // border to align, so the sidebar widths are the only interesting ones.
      for (const cols of [110, 120, 200]) {
        const borderColumns = new Set(
          stripAnsi(renderAppFrame(state, cols, 24).frame)
            .split("\n")
            .map((row) => row.search(/[╭╰│]/))
            .filter((column) => column >= 0),
        );
        expect({ cols, borderColumns: [...borderColumns] }).toEqual({
          cols,
          borderColumns: [cols - 36],
        });
      }
    });

    test("keeps a bordered pane exactly at the requested width", () => {
      // The pane that PR #34775 was about: a decision box whose content is far
      // wider than the terminal must not widen the box.
      const decision = scenarios["conversation with decision overlay"];
      for (const cols of [12, 20, 44]) {
        const box = stripAnsi(renderAppFrame(decision, cols, 24).frame)
          .split("\n")
          .filter((row) => row.includes("\u256d") || row.includes("\u2570"));
        expect(box.length).toBeGreaterThan(0);
        for (const row of box) expect(displayWidth(row)).toBe(cols);
      }
    });

    test("skips a bordered pane instead of degrading it below four inner columns", () => {
      const decision = scenarios["conversation with decision overlay"];
      const narrow = stripAnsi(renderAppFrame(decision, 5, 24).frame);
      // Silent skip, like codex's `card_inner_width() -> None`; no notice text.
      expect(narrow).not.toContain("\u256d");
      expect(narrow.toLowerCase()).not.toContain("narrow");
    });
  });

  describe("caches message layout by object identity", () => {
    function message(text: string, extra: Partial<MessageDto> = {}): MessageDto {
      return {
        id: "m1",
        topicId: "topic",
        authorId: "ai",
        text,
        createdAt: "2026-01-01T00:00:00.000Z",
        ...extra,
      } as MessageDto;
    }

    function withMessage(text: string, extra: Partial<MessageDto> = {}) {
      return setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
        message(text, extra),
      ]);
    }

    test("reuses the layout while the store keeps the same message object", () => {
      // The cache is keyed on the message reference, so an in-place mutation
      // (which `state.ts` never performs) is deliberately not observed. This
      // asserts the cache is actually live rather than silently missing.
      const stored = message("original body text");
      const state = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
        stored,
      ]);
      const first = stripAnsi(renderApp(state, 100, 30));
      expect(first).toContain("original body text");

      (stored as { text: string }).text = "mutated in place!!";
      expect(stripAnsi(renderApp(state, 100, 30))).toBe(first);

      clearMessageLayoutCache();
      expect(stripAnsi(renderApp(state, 100, 30))).toContain("mutated in place!!");
    });

    test("invalidates when the store replaces the message object", () => {
      // `upsertMessage` is how live edits reach the renderer; it swaps in a new
      // object, so the new reference misses the cache on its own.
      const base = setTopics(createInitialState("local"), [topic()]);
      const first = upsertMessage(setMessages(base, "topic", []), message("alpha bravo"));
      expect(stripAnsi(renderApp(first, 100, 30))).toContain("alpha bravo");

      // Same length, different content: a length-based key would serve stale text.
      const second = upsertMessage(first, message("alpha zulu!"));
      const rendered = stripAnsi(renderApp(second, 100, 30));
      expect(rendered).toContain("alpha zulu!");
      expect(rendered).not.toContain("alpha bravo");
    });

    test("re-renders while a message grows one character at a time", () => {
      // Every streaming delta allocates a new object, so it misses by design —
      // no explicit "still streaming" flag is needed.
      let state = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", []);
      let text = "";
      for (const character of "streamed tokens arriving one by one") {
        text += character;
        state = upsertMessage(state, message(text));
        expect(stripAnsi(renderApp(state, 100, 30))).toContain(text);
      }
    });

    test("re-renders the same object at a different width", () => {
      const state = withMessage("a fairly long sentence that wraps differently per width");
      const wide = stripAnsi(renderApp(state, 100, 30));
      const narrow = stripAnsi(renderApp(state, 44, 30));

      expect(wide).toContain("a fairly long sentence that wraps differently per width");
      expect(narrow).not.toContain("a fairly long sentence that wraps differently per width");
      expect(narrow).toContain("a fairly long");
      // Going back to the original width must not reuse the narrow layout.
      expect(stripAnsi(renderApp(state, 100, 30))).toBe(wide);
    });

    test("re-renders the same object for a different viewer", () => {
      const stored = message("who am I speaking as", { authorId: "local" });
      const mine = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
        stored,
      ]);
      const theirs = { ...mine, userId: "someone-else" };

      expect(stripAnsi(renderApp(mine, 100, 30))).toContain("\u203a who am I speaking as");
      expect(stripAnsi(renderApp(theirs, 100, 30))).toContain("\u2022 who am I speaking as");
    });

    test("re-renders an edited tool message with the same text", () => {
      const original = stripAnsi(
        renderApp(withMessage("Edit \u00b7 file.ts", { kind: "tool" }), 100, 30),
      );
      const finished = stripAnsi(
        renderApp(
          withMessage("Edit \u00b7 file.ts", {
            kind: "tool",
            editedAt: "2026-01-01T00:01:00.000Z",
          }),
          100,
          30,
        ),
      );

      // The pending marker becomes a completion marker once editedAt is set.
      expect(original).toContain("\u25cf Edit \u00b7 file.ts");
      expect(finished).toContain("\u2713 Edit \u00b7 file.ts");
    });

    test("re-renders a subagent card when only its status changes", () => {
      const card = {
        topicId: "child",
        subagentTopicId: "child",
        name: "Worker",
        task: "do the thing",
        reportMode: "auto" as const,
      };
      const running = stripAnsi(
        renderApp(
          withMessage("subagent", {
            kind: "subagent",
            subagentCard: { ...card, status: "running" },
          }),
          100,
          30,
        ),
      );
      const done = stripAnsi(
        renderApp(
          withMessage("subagent", {
            kind: "subagent",
            subagentCard: { ...card, status: "completed", resultSummary: "all done" },
          }),
          100,
          30,
        ),
      );

      expect(running).toContain("Worker  running");
      expect(done).toContain("Worker  completed");
      expect(done).toContain("all done");
    });
  });

  test("renders the Orchgraph subagent canvas through a movable viewport", () => {
    const canvasLines = [
      "╭──────────╮                   ",
      "│ ○ Root   │                   ",
      "╰──────────╯                   ",
      "     │                         ",
      "     ▼                         ",
      "                    ╭─────────╮",
      "                    │ ○ Child │",
      "                    ╰─BOTTOM──╯",
    ];
    const base = {
      ...setTopics(createInitialState("local"), [topic()]),
      overlay: "subagents" as const,
      subagentGraphLoading: false,
      subagentGraph: {
        title: "Root",
        rootDetail: "codex · gpt-5.6-luna · medium",
        rootRunning: false,
        nodes: [
          {
            id: "topic",
            label: "Root",
            state: "idle" as const,
            x: 0,
            y: 0,
            width: 12,
            height: 3,
            markerX: 2,
            markerY: 1,
          },
          {
            id: "child",
            label: "Child",
            state: "idle" as const,
            x: 20,
            y: 5,
            width: 11,
            height: 3,
            markerX: 22,
            markerY: 6,
          },
        ],
        edges: [],
        lines: canvasLines,
        width: 31,
        height: canvasLines.length,
      },
    };

    const start = stripAnsi(renderApp(base, 32, 14));
    const shifted = stripAnsi(renderApp({ ...base, subagentGraphOffset: { x: 16, y: 4 } }, 32, 14));

    expect(start).toContain("Agent graph");
    expect(start).toContain("○ Root · codex · gpt-5.6-luna");
    expect(start).toContain("[/] spacing 4");
    expect(start).toContain("○ Root");
    expect(start).not.toContain("○ Child");
    expect(shifted).toContain("○ Child");
    expect(shifted).toContain("BOTTOM");
    expect(shifted).toContain("solid ↕: parent/child");
  });

  test("shows and animates agents that start working while the graph is open", () => {
    const canvasLines = [
      "╭──────────╮",
      "│ ○ Root   │",
      "╰──────────╯",
      "     │      ",
      "     ▼      ",
      "╭──────────╮",
      "│ ○ Child  │",
      "╰──────────╯",
    ];
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      overlay: "subagents" as const,
      subagentGraphLoading: false,
      activity: {
        child: {
          running: true,
          status: "Working",
          tools: [
            {
              id: "tell",
              label: "tell_session",
              status: "done",
              sessionAction: "tell" as const,
              sessionTarget: "Root",
            },
          ],
        },
      },
      subagentGraph: {
        title: "Root",
        rootDetail: "codex · gpt-5.6-luna · medium",
        nodes: [
          {
            id: "topic",
            label: "Root",
            state: "idle" as const,
            x: 0,
            y: 0,
            width: 12,
            height: 3,
            markerX: 2,
            markerY: 1,
          },
          {
            id: "child",
            label: "Child",
            state: "idle" as const,
            x: 0,
            y: 5,
            width: 12,
            height: 3,
            markerX: 2,
            markerY: 6,
          },
        ],
        edges: [
          {
            id: "owns:topic:child",
            source: "topic",
            target: "child",
            kind: "owns" as const,
            cells: [
              { x: 5, y: 3 },
              { x: 5, y: 4 },
            ],
          },
        ],
        lines: canvasLines,
        width: 12,
        height: canvasLines.length,
      },
    };

    const firstRaw = renderApp(state, 48, 18, 0);
    const first = stripAnsi(firstRaw);
    const second = stripAnsi(renderApp(state, 48, 18, 1));

    expect(first).toContain("Working: Child");
    expect(first).toContain(`${workingFrame(0)} Child`);
    expect(second).toContain(`${workingFrame(1)} Child`);
    expect(firstRaw).toContain("\u001b[38;2;241;190;91m");
    expect(first).toContain("▼");
  });

  test("separates latest context occupancy from aggregate turn spend", () => {
    const message: MessageDto = {
      id: "usage-message",
      topicId: "topic",
      authorId: "ai",
      text: "done",
      usage: {
        input: 1_343_881,
        output: 4_698,
        cachedInput: 1_230_336,
        context: 104_464,
        contextWindow: 258_400,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const state = {
      ...setTopicUsage(
        setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [message]),
        {
          topicId: "topic",
          inputTokens: 113_545,
          outputTokens: 4_698,
          cacheCreationInputTokens: 12_000,
          cacheReadInputTokens: 1_230_336,
          queries: 9,
          estimatedCostUsd: 2.5,
          currentSession: {
            timestamp: message.createdAt,
            topicId: "topic",
            topicTitle: "Terminal",
            agent: "codex",
            model: "gpt",
            contextTokens: 104_464,
            contextWindow: 258_400,
          },
        },
      ),
      overlay: "status" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("104k / 258k (40%)");
    expect(output).toContain("input 1.34M");
    expect(output).toContain("Cache read  1.23M");
    expect(output).toContain("not context size");
    expect(output).toContain("Topic cumulative");
    expect(output).toContain("Queries     9");
    expect(output).toContain("Input       114k cache miss");
    expect(output).toContain("Est. cost   $2.5000");
  });

  test("strips terminal escape sequences", () => {
    expect(stripAnsi("safe\u001b[2Jbad")).toBe("safebad");
  });

  test("strips OSC 8 hyperlink escapes back to the plain label", () => {
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const url = "https://example.com";
    const wrapped = `see ${ESC}]8;;${url}${BEL}${url}${ESC}]8;;${BEL} now`;
    expect(stripAnsi(wrapped)).toBe(`see ${url} now`);
  });

  test("wraps a bare URL in a message body as a clickable OSC 8 hyperlink", () => {
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const message: MessageDto = {
      id: "message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "See https://example.com/docs for details.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const rendered = renderAppFrame(state, 100, 30);

    const url = "https://example.com/docs";
    expect(rendered.frame).toContain(`${ESC}]8;;${url}${BEL}${url}${ESC}]8;;${BEL}`);
    // Trailing sentence punctuation stays outside the link target.
    expect(rendered.frame).not.toContain(`${url}.`);
    // The escape bytes are display-invisible, so stripping them still reads
    // exactly like the message would without a hyperlink.
    expect(stripAnsi(rendered.frame)).toContain("See https://example.com/docs for details.");
  });

  test("keeps selection highlighting aligned across a hyperlinked URL", () => {
    const message: MessageDto = {
      id: "message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "https://example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const rendered = renderAppFrame(state, 100, 30);
    const lineIndex = rendered.frame.split("\n").findIndex((row) => row.includes("example.com"));
    expect(lineIndex).toBeGreaterThanOrEqual(0);

    const highlighted = highlightScreenSelection(rendered.frame, {
      anchor: { x: 1, y: lineIndex + 1 },
      focus: { x: 40, y: lineIndex + 1 },
    });
    // Highlighting must not corrupt the escape bytes or duplicate the label.
    expect(stripAnsi(highlighted)).toBe(stripAnsi(rendered.frame));
  });

  test("renders markdown lists and fenced code in the conversation flow", () => {
    const message: MessageDto = {
      id: "message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "## Result\n- first\n```ts\nconst ok = true;\n```",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("• first");
    expect(output).toContain("code · ts  ⧉");
    expect(output).toContain("const ok = true;");
  });

  test("exposes clickable copy targets with the original fenced code", () => {
    const message: MessageDto = {
      id: "message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "Before\n```sh\nprintf 'wide line'\necho done\n```\nAfter",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);

    const rendered = renderAppFrame(state, 100, 30);
    expect(rendered.codeCopyTargets).toHaveLength(1);
    const target = rendered.codeCopyTargets[0];
    expect(target?.text).toBe("printf 'wide line'\necho done");
    expect(target?.y).toBeGreaterThan(0);
    // The whole visible header is clickable: from "┌" through the ⧉ marker.
    const header = "┌─ code · sh  ⧉";
    expect(target?.xStart).toBe(3);
    expect((target?.xEnd ?? 0) - (target?.xStart ?? 0) + 1).toBe(header.length);
  });

  test("does not inject the speaker marker into a leading code block", () => {
    const message: MessageDto = {
      id: "message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "```markdown\n# PR body\n```",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("  ┌─ code · markdown  ⧉");
    expect(output).not.toContain("● ┌─ code");
  });

  test("renders markdown tables with box-drawing borders", () => {
    const message: MessageDto = {
      id: "table-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "| Name | Role |\n|------|------|\n| Alice | Admin |\n| Bob | User |",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    const tableLines = output
      .split("\n")
      .map((renderedLine) => renderedLine.trimEnd())
      .filter((renderedLine) => /[┌├└│]/.test(renderedLine));
    expect(
      tableLines.map((renderedLine) => renderedLine.slice(renderedLine.search(/[┌├└│]/))),
    ).toEqual([
      "┌───────┬───────┐",
      "│ Name  │ Role  │",
      "├───────┼───────┤",
      "│ Alice │ Admin │",
      "│ Bob   │ User  │",
      "└───────┴───────┘",
    ]);
  });

  test("renders markdown tables with alignment", () => {
    const message: MessageDto = {
      id: "align-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("│ a    │   b    │     c │");
  });

  test("renders markdown tables without headers (no separator row)", () => {
    const message: MessageDto = {
      id: "noheader-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "| Alice | Admin |\n| Bob | User |",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("┌");
    expect(output).toContain("┐");
    // No header separator when there is no separator row
    expect(output).not.toContain("├");
    expect(output).toContain("│ Alice");
    expect(output).toContain("│ Bob");
  });

  test("does not render prose containing a pipe as a table", () => {
    const message: MessageDto = {
      id: "pipe-prose-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "Choose foo | bar before continuing.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("Choose foo | bar before continuing.");
    expect(output).not.toContain("┌");
  });

  test("keeps escaped pipes and pipes in inline code inside a table cell", () => {
    const message: MessageDto = {
      id: "escaped-pipe-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "| Expr | Code |\n| --- | --- |\n| a \\| b | `x|y` |",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    const bodyLine = output.split("\n").find((renderedLine) => renderedLine.includes("a | b"));
    expect(bodyLine).toBeDefined();
    expect(bodyLine).toContain("‹x|y›");
    expect(bodyLine?.match(/│/g)).toHaveLength(3);
  });

  test("treats a pipe after an even backslash run as a table delimiter", () => {
    const message: MessageDto = {
      id: "even-backslash-pipe-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: String.raw`| Path | Value |
| --- | --- |
| C:\\ | next |`,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    const bodyLine = output.split("\n").find((renderedLine) => renderedLine.includes("C:\\"));
    expect(bodyLine).toBeDefined();
    expect(bodyLine).toContain("next");
    expect(bodyLine?.match(/│/g)).toHaveLength(3);
  });

  test("normalizes ragged table rows to the widest row", () => {
    const message: MessageDto = {
      id: "ragged-table-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "| A | B |\n| --- | --- |\n| 1 | 2 | 3 |",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    const headerLine = output.split("\n").find((renderedLine) => renderedLine.includes("│ A "));
    const bodyLine = output.split("\n").find((renderedLine) => renderedLine.includes("│ 1 "));
    expect(headerLine?.match(/│/g)).toHaveLength(4);
    expect(bodyLine?.match(/│/g)).toHaveLength(4);
  });

  test("keeps wide tables inside a narrow terminal and marks omitted columns", () => {
    const message: MessageDto = {
      id: "wide-table-message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: [
        "| A | B | C | D | E | F |",
        "| --- | --- | --- | --- | --- | --- |",
        "| alpha | bravo | charlie | delta | echo | foxtrot |",
      ].join("\n"),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 40, 30));
    const tableLines = output
      .split("\n")
      .map((renderedLine) => renderedLine.trimEnd())
      .filter((renderedLine) => /[┌├└│]/.test(renderedLine));
    expect(tableLines.some((renderedLine) => renderedLine.includes("…"))).toBe(true);
    expect(tableLines.every((renderedLine) => displayWidth(renderedLine) <= 40)).toBe(true);
    expect(tableLines[0]).toContain("┐");
    expect(tableLines.at(-1)).toContain("┘");
  });

  test("hides system messages from the Terminal conversation", () => {
    const systemMessage: MessageDto = {
      id: "system-message",
      topicId: "topic",
      authorId: "system",
      text: "internal orchestration detail",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const state = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
      systemMessage,
    ]);

    expect(stripAnsi(renderApp(state, 100, 30))).not.toContain("internal orchestration detail");
  });

  test("shows tell_session messages received from another topic", () => {
    const tellMessage: MessageDto = {
      id: "runtime-message",
      topicId: "topic",
      authorId: "system",
      sourceAdapter: "session-comm",
      text: "[Tell from **research**]\n\nReview the deployment result.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const state = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
      tellMessage,
    ]);

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("Tell from **research**");
    expect(output).toContain("Review the deployment result.");
  });

  test("shows legacy tell_session history saved before source metadata existed", () => {
    const legacyTell: MessageDto = {
      id: "tell-legacy-request",
      topicId: "topic",
      authorId: "system",
      text: "[from research]\nLegacy handoff.",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const state = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
      legacyTell,
    ]);

    expect(stripAnsi(renderApp(state, 100, 30))).toContain("Legacy handoff.");
  });

  test("shows compact tool status without verbose output", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "ai_active", queryId: "query" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "tool_call", queryId: "query", toolUseId: "tool", label: "Bash(test)" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "tool_output", queryId: "query", toolUseId: "tool", content: "ok" },
    });
    const rendered = renderApp(state, 100, 30);
    const output = stripAnsi(rendered);
    expect(output).toContain("Bash · test");
    expect(output).not.toContain("ok");
    expect(output).toContain("Working");
    expect(rendered).toContain("\u001b[38;2;196;181;253m");
  });

  test("keeps the SSH destination and remote action visible in tool calls", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_call",
        queryId: "query",
        toolUseId: "ssh",
        name: "Bash",
        label: "Bash(ssh · deploy@example.com · git status)",
      },
    });

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("Bash · ssh · deploy@example.com · git status");
    expect(output).not.toContain("BatchMode=yes");
  });

  test("keeps file mutations prominent and shows more Claude edit context", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_call",
        queryId: "query",
        toolUseId: "edit",
        name: "Edit",
        label: "Edit(/workspace/src/app.ts)",
        input: {
          file_path: "/workspace/src/app.ts",
          before: "old line one\nold line two\nold line three",
          after: "new line one\nnew line two\nnew line three",
        },
      },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "tool_output", queryId: "query", toolUseId: "edit", content: "ok" },
    });

    const rendered = renderApp(state, 100, 30);
    const output = stripAnsi(rendered);
    expect(output).toContain("✓ Edit · …/src/app.ts (+3 -3)");
    // Every logical diff line keeps its +/- marker, not just the first one.
    expect(output).toContain("- old line one");
    expect(output).toContain("- old line three");
    expect(output).toContain("+ new line one");
    expect(output).toContain("+ new line three");
    expect(rendered).toContain("\u001b[38;2;196;181;253m");
    expect(rendered).toContain("\u001b[48;2;45;22;28m");
    expect(rendered).toContain("\u001b[48;2;18;43;32m");
    expect(rendered).toContain("\u001b[38;2;94;211;142m\u001b[48;2;10;11;15m+3");
    expect(rendered).toContain("\u001b[38;2;245;116;128m\u001b[48;2;10;11;15m-3");
  });

  test("marks a failed Codex file change instead of pretending it succeeded", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_call",
        queryId: "query",
        toolUseId: "edit",
        name: "Edit",
        label: "Edit(/workspace/src/app.ts)",
        input: { file_path: "/workspace/src/app.ts", change_kind: "update" },
      },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_output",
        queryId: "query",
        toolUseId: "edit",
        content: "update failed: /workspace/src/app.ts",
        isError: true,
      },
    });

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("! Edit · …/src/app.ts");
    expect(output).toContain("! update failed");
    expect(output).not.toContain("✓ Edit · …/src/app.ts");
    expect(output).not.toContain("~ modified");
  });

  test("marks a failed Claude-style edit while preserving its diff", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_call",
        queryId: "query",
        toolUseId: "edit",
        name: "Edit",
        label: "Edit(/workspace/src/app.ts)",
        input: {
          file_path: "/workspace/src/app.ts",
          before: "const value = 1;",
          after: "const value = 2;",
        },
      },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_output",
        queryId: "query",
        toolUseId: "edit",
        content: "String to replace not found",
        isError: true,
      },
    });

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("! Edit · …/src/app.ts (+1 -1)");
    expect(output).toContain("- const value = 1;");
    expect(output).toContain("+ const value = 2;");
    expect(output).toContain("! failed");
    expect(output).not.toContain("✓ Edit · …/src/app.ts");
  });

  test("does not color diff context that starts with a list marker", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_call",
        queryId: "query",
        toolUseId: "edit",
        name: "Edit",
        label: "Edit(/workspace/list.md)",
        input: {
          file_path: "/workspace/list.md",
          diff_preview: "12  - unchanged item\n13  + unchanged item",
        },
      },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "tool_output", queryId: "query", toolUseId: "edit", content: "ok" },
    });

    const rendered = renderApp(state, 100, 30);
    const output = stripAnsi(rendered);
    expect(output).toContain("12  - unchanged item");
    expect(output).toContain("13  + unchanged item");
    expect(rendered).not.toContain("\u001b[48;2;45;22;28m");
    expect(rendered).not.toContain("\u001b[48;2;18;43;32m");
  });

  test("announces hidden preview lines instead of silently truncating", () => {
    const before = Array.from({ length: 10 }, (_, i) => `old ${i + 1}`).join("\n");
    const after = Array.from({ length: 10 }, (_, i) => `new ${i + 1}`).join("\n");
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_call",
        queryId: "query",
        toolUseId: "edit",
        name: "Edit",
        label: "Edit(/workspace/src/app.ts)",
        input: { file_path: "/workspace/src/app.ts", before, after },
      },
    });

    const output = stripAnsi(renderApp(state, 100, 40));
    expect(output).toContain("- old 1");
    expect(output).toContain("… +8 more lines");
    expect(output).not.toContain("+ new 10");
  });

  test("shows what an ask session sends and where", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_call",
        queryId: "query",
        toolUseId: "tool",
        name: "mcp__session-comm__ask_session",
        label: "mcp__session-comm__ask_session(review)",
        input: { to: "review", message: "Check the current diff." },
      },
    });

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("Ask session · review");
    expect(output).toContain("Check the current diff.");
  });

  test("labels the task panel as Tasks like Telegram", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [
      {
        id: "tasks-query",
        topicId: "topic",
        authorId: "system",
        text: "📋 Tasks (0/1)\n  ☐ Verify the result",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("◫ Tasks");
    expect(output).toContain("☐ Verify the result");
    expect(output).not.toContain("Shared tasks");
  });

  test("moves Tasks into a right sidebar on wide terminals", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [
      {
        id: "tasks-sidebar",
        topicId: "topic",
        authorId: "system",
        text: "📋 Tasks (0/2)\n[->] Implement sidebar\n[ ] Verify layout",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const rendered = renderApp(state, 120, 30);
    const output = stripAnsi(rendered);
    const taskHeader = output.split("\n").find((row) => row.includes("Tasks"));
    expect(taskHeader?.indexOf("Tasks")).toBeGreaterThan(80);
    expect(taskHeader).toContain("Tasks · Ctrl-T");
    expect(rendered).toContain("\u001b[38;2;151;118;56m");
    expect(output).toContain("[->] Implement sidebar");
    expect(output).toContain("[ ] Verify layout");
    expect(output).not.toContain("◫ Tasks");

    const inline = stripAnsi(renderApp({ ...state, taskSidebarEnabled: false }, 120, 30));
    expect(inline).toContain("◫ Tasks · Ctrl-T sidebar");
    expect(
      inline
        .split("\n")
        .find((row) => row.includes("Tasks"))
        ?.indexOf("Tasks"),
    ).toBeLessThan(20);
  });

  test("keeps current work visible and counts overflow in the Tasks sidebar", () => {
    const done = Array.from({ length: 30 }, (_, i) => `[x] Done task ${i + 1}`);
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [
      {
        id: "tasks-overflow",
        topicId: "topic",
        authorId: "system",
        text: ["📋 Tasks (30/31)", "[->] Current work", ...done].join("\n"),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("[->] Current work");
    const more = output.match(/\+(\d+) more/);
    expect(more).not.toBeNull();
    expect(Number(more?.[1])).toBeGreaterThan(0);
    // Oldest completed tasks are the ones that overflow.
    expect(output).not.toContain("[x] Done task 1 ");
  });

  test("prioritizes active work over queued tasks in a short Tasks sidebar", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [
      {
        id: "tasks-active-first",
        topicId: "topic",
        authorId: "system",
        text: [
          "Tasks (0/4)",
          "[ ] Queued first",
          "[ ] Queued second",
          "[->] Active now",
          "[ ] Queued last",
        ].join("\n"),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const output = stripAnsi(renderApp(state, 120, 14));
    const activeIndex = output.indexOf("[->] Active now");
    const queuedIndex = output.indexOf("[ ] Queued first");
    expect(activeIndex).toBeGreaterThanOrEqual(0);
    expect(queuedIndex < 0 || activeIndex < queuedIndex).toBe(true);
  });

  test("counts hidden tasks in the inline Tasks panel on narrow terminals", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => `[ ] Task ${i + 1}`);
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [
      {
        id: "tasks-inline",
        topicId: "topic",
        authorId: "system",
        text: ["📋 Tasks (0/8)", ...tasks].join("\n"),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("◫ Tasks");
    expect(output).toContain("[ ] Task 5");
    expect(output).not.toContain("[ ] Task 6");
    expect(output).toContain("+3 more");
  });

  test("shows unfinished tasks before the most recently completed tasks", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [
      {
        id: "tasks-priority",
        topicId: "topic",
        authorId: "system",
        text: [
          "📋 Tasks (6/8)",
          "[x] Old 1",
          "[x] Old 2",
          "[x] Old 3",
          "[x] Old 4",
          "[x] Old 5",
          "[x] Old 6",
          "[ ] Current",
          "[->] Running",
        ].join("\n"),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("[ ] Current");
    expect(output).toContain("[->] Running");
    expect(output).toContain("[x] Old 6");
    expect(output).not.toContain("[x] Old 1");
  });

  test("animates the working indicator without requiring another runtime event", () => {
    expect(WORKING_FRAME_INTERVAL_MS).toBe(50);
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "ai_active", queryId: "query" },
    });

    const first = stripAnsi(renderApp(state, 100, 30, 0));
    const second = stripAnsi(renderApp(state, 100, 30, 1));
    expect(first).toContain(`${workingFrame(0)} Working`);
    expect(second).toContain(`${workingFrame(1)} Working`);
    expect(first.match(/Working/g)).toHaveLength(1);
    expect(second.match(/Working/g)).toHaveLength(1);
    expect(first).not.toBe(second);
  });

  test("animates running topics in the topic picker", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "ai_active", queryId: "query" },
    });
    state = openTopicPicker(state);

    const first = stripAnsi(renderApp(state, 100, 30, 0));
    const second = stripAnsi(renderApp(state, 100, 30, 1));
    expect(first).toContain(`${workingFrame(0)} Terminal`);
    expect(second).toContain(`${workingFrame(1)} Terminal`);
    expect(first).not.toBe(second);
  });

  test("advances working time from the terminal clock instead of provider heartbeats", () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { kind: "ai_active", queryId: "query" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_status",
        queryId: "query",
        statusKind: "progress",
        content: "Working… 111s",
        toolName: "working",
        elapsed: 111,
      },
    });

    const at106 = stripAnsi(renderApp(state, 100, 30, 0, startedAt + 106_000));
    const at107 = stripAnsi(renderApp(state, 100, 30, 1, startedAt + 107_000));
    expect(at106).toContain("Working · 1m 46s");
    expect(at107).toContain("Working · 1m 47s");
    expect(at106).not.toContain("111s");
  });

  test("shows compact speaker marks without names or timestamps", () => {
    const messages: MessageDto[] = [
      {
        id: "user-message",
        topicId: "topic",
        authorId: "local",
        text: "question",
        createdAt: "2026-01-01T18:39:00.000Z",
      },
      {
        id: "ai-message",
        topicId: "topic",
        authorId: "ai",
        agentType: "codex",
        text: "answer",
        createdAt: "2026-01-01T18:40:00.000Z",
      },
    ];
    let state = setTopics(createInitialState("local"), [topic()]);
    state = { ...state, aiName: "Nova" };
    state = setMessages(state, "topic", messages);

    const rendered = renderApp(state, 100, 30);
    const renderedLines = rendered.split("\n");
    const outputLines = stripAnsi(rendered).split("\n");
    const userLine = renderedLines[outputLines.findIndex((line) => line.includes("› question"))];
    const aiLine = renderedLines[outputLines.findIndex((line) => line.includes("● answer"))];
    const output = outputLines.join("\n");
    expect(output).toContain("› question");
    expect(output).toContain("● answer");
    expect(userLine).toContain("\u001b[48;2;24;27;36m");
    expect(aiLine).toContain("\u001b[48;2;10;11;15m");
    expect(output).not.toContain("You");
    expect(output).not.toContain("Nova");
    expect(output).not.toContain("06:39");
    expect(output).not.toContain("06:40");
  });

  test("clamps at the loaded history boundary and exposes explicit older loading", () => {
    const messages: MessageDto[] = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      topicId: "topic",
      authorId: "local",
      text: `conversation-${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", messages);
    const latest = stripAnsi(renderApp(state, 100, 16));
    expect(latest).toContain("conversation-19");
    expect(latest).not.toContain("conversation-0");

    state = {
      ...state,
      scrollOffset: 10_000,
      messageHistory: { topic: { hasMore: true, loading: false } },
    };
    const history = stripAnsi(renderApp(state, 100, 16));
    expect(history).toContain("Loaded history start · Ctrl-E load older");
    expect(history).toContain("conversation-0");
    expect(history).not.toContain("conversation-19");

    state = {
      ...state,
      messageHistory: { topic: { hasMore: false, loading: false } },
    };
    expect(stripAnsi(renderApp(state, 100, 16))).toContain("Start of conversation");
  });

  test("keeps the visible history anchored while live output grows below it", () => {
    const messages: MessageDto[] = Array.from({ length: 24 }, (_, index) => ({
      id: `message-${index}`,
      topicId: "topic",
      authorId: "local",
      text: `conversation-${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    let previous = setTopics(createInitialState("local"), [topic()]);
    previous = setMessages(previous, "topic", messages);
    previous = { ...previous, scrollOffset: 8 };
    const before = stripAnsi(renderApp(previous, 100, 16))
      .split("\n")
      .filter((value) => value.includes("conversation-"));

    const next = setMessages(previous, "topic", [
      ...messages,
      {
        id: "live-message",
        topicId: "topic",
        authorId: "ai",
        text: "live-line-1\nlive-line-2\nlive-line-3",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ]);
    const anchored = preserveConversationScrollAnchor(previous, next, 100, 16);
    const after = stripAnsi(renderApp(anchored, 100, 16))
      .split("\n")
      .filter((value) => value.includes("conversation-"));

    expect(anchored.scrollOffset).toBeGreaterThan(previous.scrollOffset);
    expect(after).toEqual(before);
  });
});

describe("topic picker filter rendering", () => {
  function room(id: string, title: string, extra: Partial<TopicDto> = {}): TopicDto {
    return { ...topic(), id, title, ...extra };
  }

  const rooms = [room("a", "Design review"), room("b", "설계 회의"), room("c", "Deploy pipeline")];

  function picker(query: string, cols = 100) {
    const state = setTopicFilter(
      openTopicPicker(setTopics(createInitialState("local"), rooms)),
      query,
    );
    return stripAnsi(renderApp(state, cols, 20));
  }

  /** Overlay rows only; the footer separately echoes the *active* topic title. */
  function listRows(output: string): string {
    return output
      .split("\n")
      .filter((row) => row.includes("  ○ "))
      .join("\n");
  }

  test("shows the active query and hides non-matching topics", () => {
    const output = picker("회의");
    expect(output).toContain("Filter: 회의");
    expect(output).toContain("설계 회의");
    expect(listRows(output)).not.toContain("Design review");
    expect(listRows(output)).not.toContain("Deploy pipeline");
    // Escape is re-advertised as "clear the filter" while a query is live.
    expect(output).toContain("Esc clears the filter");
  });

  test("matches case-insensitively", () => {
    const output = picker("DESIGN");
    expect(output).toContain("Design review");
    expect(listRows(output)).not.toContain("Deploy pipeline");
  });

  test("explains an empty result instead of showing a blank list", () => {
    const output = picker("nothing-matches");
    expect(output).toContain("No topics match");
    expect(output).toContain("Esc clears the filter");
  });

  test("omits the filter row entirely when no query is active", () => {
    const output = picker("");
    expect(output).not.toContain("Filter:");
    expect(output).toContain("Design review");
    expect(output).toContain("설계 회의");
  });

  test("advertises the new chords and no longer mentions the removed ones", () => {
    const output = picker("", 140);
    expect(output).toContain("type to filter");
    expect(output).toContain("Ctrl-N new");
    expect(output).toContain("Ctrl-D delete");
    expect(output).not.toContain("· N new");
    expect(output).not.toContain("D/Del delete");
  });

  test("the help overlay drops the retired Ctrl-P/N topic cycling", () => {
    const state = { ...setTopics(createInitialState("local"), rooms), overlay: "help" as const };
    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).not.toContain("Ctrl-P/N");
    expect(output).not.toContain("previous/next topic");
  });

  test("anchors the hardware cursor at the end of the filter query", () => {
    // The composer is hidden behind the picker, so its caret is gone. Without an
    // explicit one the frame reported `cursor: null` and the terminal left the
    // hardware cursor wherever the previous frame put it — which is where a
    // Hangul IME draws its preedit, so composing a Korean query showed the
    // in-progress syllable in the wrong place.
    const state = setTopicFilter(
      openTopicPicker(setTopics(createInitialState("local"), rooms)),
      "회의",
    );
    const rendered = renderAppFrame(state, 100, 24);
    expect(rendered.cursor).not.toBeNull();
    const rows = stripAnsi(rendered.frame).split("\n");
    const row = rows[(rendered.cursor?.y ?? 1) - 1];
    expect(row).toContain("Filter: 회의");
    // One cell past the last character of the query, counting Hangul as wide.
    expect(rendered.cursor?.x).toBe(displayWidth("  Filter: 회의") + 1);

    // An empty query still gets a caret, parked where the first character will
    // be drawn. Hangul preedit starts *before* anything is committed, so this
    // is precisely the state in which the first syllable of a Korean search is
    // composed; returning null here left it at the previous frame's cursor.
    const unfiltered = openTopicPicker(setTopics(createInitialState("local"), rooms));
    const empty = renderAppFrame(unfiltered, 100, 24).cursor;
    expect(empty).toEqual({ x: displayWidth("  Filter: ") + 1, y: 3 });
    // Committing the first character advances the caret by exactly one cell.
    const typed = renderAppFrame(setTopicFilter(unfiltered, "D"), 100, 24).cursor;
    expect(typed).toEqual({ x: (empty?.x ?? 0) + 1, y: 3 });
  });

  test("keeps the filter caret inside the frame at every width", () => {
    const state = setTopicFilter(
      openTopicPicker(setTopics(createInitialState("local"), rooms)),
      "e 설계 회의 매우 긴 필터 문자열",
    );
    for (const cols of [1, 2, 3, 5, 8, 12, 20, 31, 40, 80, 120]) {
      for (const rows of [14, 20, 24, 60]) {
        const cursor = renderAppFrame(state, cols, rows).cursor;
        expect({ cols, rows, cursor: cursor === null }).toEqual({ cols, rows, cursor: false });
        expect(cursor?.x).toBeGreaterThanOrEqual(1);
        expect(cursor?.x).toBeLessThanOrEqual(cols);
        expect(cursor?.y).toBeGreaterThanOrEqual(1);
        expect(cursor?.y).toBeLessThanOrEqual(Math.max(14, rows));
      }
    }
  });

  test("keeps every row within the terminal width while filtering", () => {
    const state = setTopicFilter(
      openTopicPicker(setTopics(createInitialState("local"), [rooms[0], rooms[1], rooms[2]])),
      "e 설계 회의 매우 긴 필터 문자열",
    );
    for (const cols of [1, 2, 3, 5, 8, 12, 20, 31, 40, 80, 120]) {
      const rendered = renderAppFrame(state, cols, 24);
      const rows = rendered.frame.split("\n");
      expect({ cols, widths: rows.map((row) => displayWidth(stripAnsi(row))) }).toEqual({
        cols,
        widths: rows.map(() => cols),
      });
    }
  });
});
