import { z } from "zod";
import { errorResult, type SharedMcpTool, textResult } from "#agents/mcp-tools/common";

export const VISUALS_MCP_KEY = "visuals";

export const showHtmlTool = {
  name: "show_html",
  description:
    "Display charts, tables, or interactive HTML to the user in a sandboxed WebView side panel. Pass a complete, self-contained HTML string with inline CSS/JS. Local DOM interactions are supported. Links (<a href> to http/https URLs) are safe to include: a click opens the URL in the user's system browser. Network requests, external scripts, form posts, popups, and parent-window access are blocked.",
  schema: {
    html: z.string().describe("Complete, self-contained HTML document or fragment to render."),
    title: z.string().optional().describe("Optional title shown above the rendered card."),
  },
  async handler() {
    return textResult("HTML card displayed to the user.");
  },
} satisfies SharedMcpTool;

export const showMermaidTool = {
  name: "show_mermaid",
  description:
    "Render a Mermaid diagram in the user's visual side panel. Pass Mermaid DSL only, not markdown fences. Use this for flowcharts, sequence diagrams, class diagrams, state diagrams, ER diagrams, timelines, and architecture diagrams.",
  schema: {
    code: z.string().describe("Mermaid diagram source without markdown code fences."),
    title: z.string().optional().describe("Optional title shown above the rendered card."),
    theme: z
      .enum(["default", "neutral", "dark", "forest"])
      .optional()
      .describe("Optional Mermaid theme. Defaults to neutral."),
  },
  async handler() {
    return textResult("Mermaid diagram displayed to the user.");
  },
} satisfies SharedMcpTool;

export const showImageTool = {
  name: "show_image",
  description:
    "Display an image in the user's visual side panel. Provide either file_path for an image in the topic workspace, or file_id for an uploaded file already attached in this topic.",
  schema: {
    file_path: z
      .string()
      .optional()
      .describe("Absolute or workspace-relative path to an image file."),
    file_id: z
      .string()
      .optional()
      .describe("Full Otium uploaded file UUID for an image attached in this topic."),
    title: z.string().optional().describe("Optional title shown above the rendered card."),
    alt: z.string().optional().describe("Optional alt text for the image."),
  },
  async handler(input) {
    if (!input?.file_path && !input?.file_id) {
      return errorResult("file_path or file_id is required.");
    }
    return textResult("Image displayed to the user.");
  },
} satisfies SharedMcpTool;

export const showVideoTool = {
  name: "show_video",
  description:
    "Display a playable video in the user's visual side panel. Provide either file_path for a video in the topic workspace, or file_id for an uploaded file already attached in this topic.",
  schema: {
    file_path: z
      .string()
      .optional()
      .describe("Absolute or workspace-relative path to a video file."),
    file_id: z
      .string()
      .optional()
      .describe("Full Otium uploaded file UUID for a video attached in this topic."),
    title: z.string().optional().describe("Optional title shown above the rendered card."),
  },
  async handler(input) {
    if (!input?.file_path && !input?.file_id) {
      return errorResult("file_path or file_id is required.");
    }
    return textResult("Video displayed to the user.");
  },
} satisfies SharedMcpTool;

export const visualToolDefinitions = [
  showHtmlTool,
  showMermaidTool,
  showImageTool,
  showVideoTool,
] as const;
