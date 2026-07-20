import { describe, expect, test } from "bun:test";
import {
  buildChannelSystemPrompt,
  buildManagerSystemPrompt,
  buildMemoryPromptSection,
  buildTopicSystemPrompt,
  loadAgentPrompt,
} from "#prompts/builders";

describe("loadAgentPrompt", () => {
  test("loads live agent prompts with frontmatter metadata", () => {
    const prompt = loadAgentPrompt("wiki-archiver.md");
    expect(prompt.name).toBe("wiki-archiver");
    expect(prompt.type).toBe("programmatic");
    expect(prompt.model).toBe("deepseek-pro");
    expect(prompt.prompt).toContain("wiki");
  });
});

describe("session system prompt builders", () => {
  test("builds topic prompt from the session template", () => {
    const prompt = buildTopicSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "Research",
      workspaceCwd: "/otium/workspace/topics/research",
      agentKind: "claude",
      currentModel: "opus",
      currentEffort: "high",
      visualTools: true,
      fileDeliveryTools: true,
    });

    expect(prompt).toContain('named "Otium"');
    expect(prompt).toContain("Topic: Research");
    expect(prompt).toContain("/otium/workspace/topics/research/attachments");
    expect(prompt).toContain("mcp__runtime__show_html");
    expect(prompt).toContain("Visual HTML runs in a sandbox");
    expect(prompt).toContain("Visual Design System");
    expect(prompt).toContain("--viz-series-1");
    expect(prompt).toContain("mcp__runtime__send_file");
    expect(prompt).toContain("mcp__runtime__ask_user_question");
    expect(prompt).toContain("mcp__runtime__schedule_self");
    expect(prompt).toContain("mcp__runtime__update_self_schedule");
    expect(prompt).toContain("mcp__runtime__cancel_self_schedule");
    expect(prompt).toContain('Do not use provider built-in "AskUserQuestion"');
    expect(prompt).toContain("mcp__task__task_create");
    expect(prompt).toContain("TodoWrite");
    expect(prompt).toContain('"Task", "Agent"');
    expect(prompt).toContain("`tell_session`");
    expect(prompt).toContain("`ask_session`");
    expect(prompt).toContain("mcp__runtime__set_model");
    expect(prompt).toContain("agent=`claude`, model=`opus`, effort=`high`");
    expect(prompt).toContain("codex / `gpt-5.6-sol` [Fable-level]");
    expect(prompt).toContain("maestro / `deepseek-pro` [Sonnet-level]");
    expect(prompt).toContain("maestro / `kimi-k3` [Fable-level]");
    expect(prompt).toContain("maestro / `kimi-k2.7-code` [Opus-level]");
    expect(prompt).not.toContain("deepseek-flash");
    expect(prompt).toContain("Codex Pro 20x and Claude Max 20x are each $200/month");
    expect(prompt).toContain("DeepSeek Pro is cheapest");
    expect(prompt).not.toContain("Community observations vary");
    expect(prompt).not.toContain("raw/cached tokens per week");
    expect(prompt).not.toContain("Marginal tokens:");
    expect(prompt).toContain("Choose the best-fit model directly");
    expect(prompt).not.toContain("move up one step");
    expect(prompt).toContain("`set_agent` autonomous calls are forbidden");
    expect(prompt).toContain("explicitly asks to change the model, agent backend");
    expect(prompt).toContain("Use `{{KEY}}` directly in browser tools");
    expect(prompt.replaceAll("{{KEY}}", "")).not.toContain("{{");
  });

  test("inserts replacement-pattern characters literally", () => {
    const prompt = buildTopicSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "Cost $& $1 $$",
      workspaceCwd: "/otium/workspace/topics/replacement",
      agentKind: "claude",
    });

    expect(prompt).toContain("Topic: Cost $& $1 $$.");
  });

  test("builds manager prompt as topic prompt plus manager role", () => {
    const prompt = buildManagerSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "General",
      workspaceCwd: "/otium/workspace/topics/general",
      agentKind: "codex",
      visualTools: true,
      fileDeliveryTools: true,
    });

    expect(prompt).toContain("## Manager Role");
    expect(prompt).toContain("runtime MCP tools");
    expect(prompt).toContain("`register_topic`");
    expect(prompt).toContain("`restart_topic`");
    expect(prompt).not.toContain("`create_topic`");
    expect(prompt).not.toContain("`update_topic`");
    expect(prompt).toContain("session-comm `tell_session`");
    expect(prompt).toContain("`ask_session`");
    expect(prompt).not.toContain("send_message");
    expect(prompt).toContain("mcp__runtime");
    expect(prompt).toContain("send_file");
    expect(prompt).toContain("ask_user_question");
    expect(prompt).toContain("schedule_self");
    expect(prompt).toContain("get_self_schedule");
    expect(prompt).toContain("mcp__task");
    expect(prompt).toContain("mcp__runtime__set_model");
    expect(prompt).toContain("show_html");
    expect(prompt.replaceAll("{{KEY}}", "")).not.toContain("{{");
  });

  test("builds maestro prompt with unprefixed MCP tool names", () => {
    const prompt = buildTopicSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "Design",
      workspaceCwd: "/otium/workspace/topics/design",
      agentKind: "maestro",
      visualTools: true,
      fileDeliveryTools: true,
    });

    expect(prompt).toContain("mcp__runtime__show_html");
    expect(prompt).toContain("mcp__runtime__send_file");
    expect(prompt).toContain("mcp__runtime__ask_user_question");
    expect(prompt).toContain("mcp__task__task_update");
    expect(prompt).toContain("mcp__runtime__set_model");
    expect(prompt).toContain("mcp__session-comm__tell_session");
    expect(prompt).toContain("mcp__session-comm__ask_session");
    expect(prompt).toContain("ToolSearch");
    expect(prompt).toContain('Do not use provider built-in "AskUserQuestion"');
    expect(prompt).toContain(
      'Do not use the Maestro "Agent" sub-agent tool either; it is disabled',
    );
    expect(prompt).not.toContain('"Task", "Agent"');
  });

  test("builds mention-only channel prompt with participant identity", () => {
    const prompt = buildChannelSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "Design",
      workspaceCwd: "/otium/workspace/topics/channel-design",
      agentKind: "claude",
      visualTools: true,
      fileDeliveryTools: true,
    });

    expect(prompt).toContain('Your name is "Otium"');
    expect(prompt).toContain('"@Otium"');
    expect(prompt).toContain("person in the room");
    expect(prompt).toContain("answer the current mention naturally");
    expect(prompt).toContain("Channel: Design");
    expect(prompt).toContain("/otium/workspace/topics/channel-design/attachments");
    expect(prompt).toContain("mcp__runtime__show_html");
    expect(prompt).toContain("mcp__task__task_create");
    expect(prompt).toContain("mcp__runtime__set_model");
    expect(prompt).not.toContain("## Memory");
    expect(prompt.replaceAll("{{KEY}}", "")).not.toContain("{{");
  });

  test("omits Otium visual tools when the adapter does not grant them", () => {
    const prompt = buildTopicSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "Terminal",
      workspaceCwd: "/negotium/workspace/topics/terminal",
      agentKind: "codex",
    });

    expect(prompt).not.toContain("show_html");
    expect(prompt).not.toContain("show_mermaid");
    expect(prompt).not.toContain("show_image");
    expect(prompt).not.toContain("show_video");
    expect(prompt).not.toContain("Visual Design System");
    expect(prompt).not.toContain("## File Delivery");
    expect(prompt).not.toContain("send_file");
    expect(prompt).toContain("ask_user_question");
  });

  test("builds memory prompt section", () => {
    const memory = buildMemoryPromptSection({
      topicId: "general",
      wikiDir: "/tmp/wiki",
      hasFiles: true,
      latestSummaryFile: "/tmp/wiki/summaries/2026-06-25-general.md",
      hasArchive: true,
      isManager: true,
    });

    expect(memory).toContain("## Memory");
    expect(memory).toContain("/tmp/wiki/topic/general.md");
    expect(memory).toContain("/tmp/wiki/summaries/2026-06-25-general.md");
  });
});
