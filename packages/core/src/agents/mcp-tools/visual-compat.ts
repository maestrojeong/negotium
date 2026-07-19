import type { SharedMcpTool } from "#agents/mcp-tools/common";
import {
  showHtmlTool,
  showImageTool,
  showMermaidTool,
  showVideoTool,
} from "#agents/mcp-tools/visuals";

/** Backward-compatible Otium alias retained for persisted prompts and sessions. */
export const showPngTool = {
  name: "show_png",
  description:
    "Backward-compatible alias for show_image. Display a PNG or other image from this topic's workspace or an uploaded file in the visual side panel.",
  schema: showImageTool.schema,
  handler: showImageTool.handler,
} satisfies SharedMcpTool;

export const otiumVisualToolDefinitions = [
  showHtmlTool,
  showMermaidTool,
  showImageTool,
  showPngTool,
  showVideoTool,
] as const;
