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
    expect(prompt).toContain('Do not use provider built-in "AskUserQuestion"');
    expect(prompt).toContain("mcp__task__task_create");
    expect(prompt).toContain("TodoWrite");
    expect(prompt).toContain('"Task", "Agent"');
    expect(prompt).toContain("mcp__runtime__set_model");
    expect(prompt).not.toContain("{{");
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
    });

    expect(prompt).toContain("## Manager Role");
    expect(prompt).toContain("topic-admin MCP tools");
    expect(prompt).toContain("mcp__runtime");
    expect(prompt).toContain("send_file");
    expect(prompt).toContain("ask_user_question");
    expect(prompt).toContain("mcp__task");
    expect(prompt).toContain("mcp__runtime__set_model");
    expect(prompt).toContain("show_html");
    expect(prompt).not.toContain("{{");
  });

  test("builds maestro prompt with unprefixed MCP tool names", () => {
    const prompt = buildTopicSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "Design",
      workspaceCwd: "/otium/workspace/topics/design",
      agentKind: "maestro",
    });

    expect(prompt).toContain("mcp__runtime__show_html");
    expect(prompt).toContain("mcp__runtime__send_file");
    expect(prompt).toContain("mcp__runtime__ask_user_question");
    expect(prompt).toContain("mcp__task__task_update");
    expect(prompt).toContain("mcp__runtime__set_model");
    expect(prompt).toContain('Do not use provider built-in "AskUserQuestion"');
    expect(prompt).toContain('The Maestro "Agent" sub-agent tool is still available');
    expect(prompt).not.toContain('"Task", "Agent"');
  });

  test("builds mention-only channel prompt with participant identity", () => {
    const prompt = buildChannelSystemPrompt({
      aiLabel: "Otium",
      topicTitle: "Design",
      workspaceCwd: "/otium/workspace/topics/channel-design",
      agentKind: "claude",
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
    expect(prompt).not.toContain("{{");
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
