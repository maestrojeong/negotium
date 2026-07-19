export { deepMapStrings } from "#agents/deep-map";
export {
  errorResult,
  type McpTextContent,
  type McpToolResult,
  type SharedMcpTool,
  textResult,
} from "#agents/mcp-tools/common";
export {
  type McpContent,
  type McpErrorResponse,
  type McpResponse,
  mcpError,
  mcpOk,
  parseUserIdArg,
} from "#mcp/mcp-helpers";
export { delay } from "#platform/delay";
export { errMsg } from "#platform/error";
export {
  appendJsonlEntry,
  appendJsonlLine,
  parseJsonlText,
  readJsonFile,
  readJsonlLines,
  writeJsonFileAtomic,
  writeJsonlFile,
} from "#platform/jsonl";
export {
  createLifecycleManager,
  type LifecycleLogger,
  type LifecycleManager,
  type LifecycleManagerOptions,
  type LifecycleProcessHost,
  onShutdown,
  runShutdown,
  type ShutdownHandler,
  type SignalReason,
} from "#platform/lifecycle";
export { escapeRegExp, mentionsAi } from "#runtime/channel-context";
export {
  buildContextWarningText,
  type ClaudeRequestTokenUsage,
  type ContextOccupancy,
  type ContextWarningOptions,
  type ContextWarningState,
  type ContextWarningTextOptions,
  claudeRequestContextTokens,
  clearContextWarning,
  contextUsageRatio,
  createContextWarningState,
  DEFAULT_CONTEXT_WARNING_RATIO,
  formatContextTokenCount,
  nextContextWarning,
  shouldWarnForContext,
} from "#runtime/context-warning";
export { renderTaskPanel, taskPanelMessageId } from "#runtime/task-format";
export {
  buildMermaidHtml,
  MERMAID_BROWSER_ASSET_PATH,
  MERMAID_BROWSER_ASSET_RELATIVE_URL,
  MERMAID_BROWSER_VERSION,
  type MermaidTheme,
  mermaidThemeFromHtml,
  normalizeMermaidTheme,
} from "#runtime/visual-html";
export { sanitizeFileName, sanitizeId, sanitizeTopicName } from "#security/sanitize";
export { isSensitivePath } from "#security/sensitive-path";
export { topicAppLink, topicMarkdownLink } from "#topics/links";
