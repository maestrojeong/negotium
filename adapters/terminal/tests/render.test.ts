import { describe, expect, test } from "bun:test";
import type { MessageDto, TopicDto } from "@negotium/core";
import { terminalNowMs } from "@/clock";
import {
  displayWidth,
  effectiveTopicModel,
  formatElapsedDuration,
  renderApp,
  renderAppFrame,
  stripAnsi,
  WORKING_FRAME_INTERVAL_MS,
  workingFrame,
  wrapText,
} from "@/render";
import {
  applyRuntimeEvent,
  createInitialState,
  openTopicPicker,
  setMessages,
  setTopics,
} from "@/state";

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
          suggestionIndex: 7,
        },
        100,
        24,
      ),
    );

    expect(output).toContain("› /private");
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

  test("shows both the agent and effective model in the topic picker", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Terminal  ·  codex  ·  gpt  ·  medium");
    expect(output).toContain("Ctrl-C exit; work continues");
  });

  test("groups manager, private, and public topics separately", () => {
    const general = {
      ...topic(),
      id: "general",
      title: "General",
      kind: "manager" as const,
      accessMode: "private" as const,
    };
    const work = { ...topic(), id: "work", title: "Work", accessMode: "private" as const };
    const shared = { ...topic(), id: "shared", title: "Shared", accessMode: "shared" as const };
    const state = {
      ...setTopics(createInitialState("local"), [work, shared, general]),
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("  Manager");
    expect(output).toContain("  Private");
    expect(output).toContain("  Public");
    expect(output.indexOf("Manager")).toBeLessThan(output.indexOf("○ General"));
    expect(output.indexOf("○ General")).toBeLessThan(output.indexOf("────"));
    expect(output.indexOf("────")).toBeLessThan(output.indexOf("Private"));
    expect(output.indexOf("Private")).toBeLessThan(output.indexOf("○ Work"));
    expect(output.indexOf("○ Work")).toBeLessThan(output.indexOf("Public"));
    expect(output.indexOf("Public")).toBeLessThan(output.indexOf("○ Shared"));
  });

  test("shows active Cron and Memory sessions in read-only groups", () => {
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
      ],
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Memory");
    expect(output).toContain("Archive Research  ·  Tool: wiki_save");
    expect(output).toContain("Cron");
    expect(output).toContain("Daily digest  ·  Running");
    expect(output.indexOf("Daily digest")).toBeLessThan(output.indexOf("Archive Research"));
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
    expect(rendered.cursor).toBeNull();
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
    expect(rendered.cursor).toBeNull();
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
    expect(output).not.toContain("deepseek-flash");
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

  test("indents subagent topics with a child arrow in the topic picker", () => {
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

    expect(parentLine).not.toContain("↳");
    expect(childLine).toContain("↳ ○ Child");
    expect(output.indexOf("Parent")).toBeLessThan(output.indexOf("Child"));
    expect(output).not.toContain("SUBAGENT");
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
      ...setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [message]),
      overlay: "status" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("104K / 258K (40%)");
    expect(output).toContain("input 1.34M");
    expect(output).toContain("Cache read  1.23M");
    expect(output).toContain("not context size");
  });

  test("strips terminal escape sequences", () => {
    expect(stripAnsi("safe\u001b[2Jbad")).toBe("safebad");
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
});
