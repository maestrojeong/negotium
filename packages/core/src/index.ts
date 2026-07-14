/**
 * @negotium/core public API.
 *
 * Hosts embed the runtime through this barrel: create/list topics, trigger
 * turns, subscribe to the RuntimeBus, and mount MCP catalogs for agent turns.
 * Deep imports are not part of the public contract.
 */

// ── Agents ──────────────────────────────────────────────────────────
export { checkAgentAuth } from "#agents/auth-check";
export { killOwnedCodexTreesForShutdown } from "#agents/codex-tree-kill";
export type { ForkHandle } from "#agents/fork";
export { cleanupAgentFork, forkAgentSession } from "#agents/fork";
export { runAgent, SUPPORTED_AGENTS } from "#agents/index";
export { createAskUserToolDefinition } from "#agents/mcp-tools/ask-user";
export type { McpToolResult, SharedMcpTool } from "#agents/mcp-tools/common";
export { errorResult, textResult } from "#agents/mcp-tools/common";
export type { SelfConfigContext } from "#agents/mcp-tools/self-config";
export { createSelfConfigToolDefinitions } from "#agents/mcp-tools/self-config";
export { createSpawnSubagentToolDefinition } from "#agents/mcp-tools/spawn-subagent";
export { visualToolDefinitions } from "#agents/mcp-tools/visuals";
export {
  AGENT_DISPLAY_NAME,
  modelOwner,
  resolveModelForAgent,
} from "#agents/model-catalog";
export { getRegistry } from "#agents/registry";
export type {
  PurgeSessionRef,
  PurgeTopicLogsOptions,
  RotateTopicLogsOptions,
  RotateTopicLogsResult,
} from "#agents/topic-cleanup";
export { purgeTopicLogs, rotateTopicLogs } from "#agents/topic-cleanup";
export type { RuntimeBus, RuntimeBusEvent, RuntimeBusListener } from "#bus";
// ── Host boundary ───────────────────────────────────────────────────
export { runtimeBus, setRuntimeBus, WsHub } from "#bus";
export type { RuntimeMcpContext } from "#mcp/runtime-spec";
export {
  buildRuntimeMcpSpec,
  getRuntimeMcpPort,
  issueRuntimeMcpToken,
  RUNTIME_MCP_BASE_PATH,
  RUNTIME_MCP_KEY,
  resolveRuntimeMcpToken,
  setRuntimeMcpPort,
} from "#mcp/runtime-spec";
// ── Media ───────────────────────────────────────────────────────────
export { extractFileEvents, extractFileTagPaths, stripFileTags } from "#media/file-events";
export type { ExtractionResult, TranscribeAudioOptions } from "#media/text-extractor";
export { extractText, isTranscriptionConfigured, transcribeAudio } from "#media/text-extractor";
export { killAllBgBash } from "#platform/background-bash/manager";
// ── Platform ────────────────────────────────────────────────────────
export {
  DATA_DIR,
  MAX_TELL_DEPTH,
  NEGOTIUM_PORT,
  RUN_DIR,
  resolveTopicWorkspaceDir,
  SESSION_INBOX_DIR,
  STATE_DIR,
  WORKSPACE_DIR,
} from "#platform/config";
export { FROM_AUTO_CONTINUE } from "#platform/constants";
export { errMsg } from "#platform/error";
export { appendJsonlEntry } from "#platform/jsonl";
export { onShutdown, runShutdown } from "#platform/lifecycle";
export { logger } from "#platform/logger";
export type {
  NodeMcpEntry,
  RuntimeMcpBuildContext,
  RuntimeMcpCatalogEntry,
  RuntimeMcpScope,
} from "#platform/mcp-config";
// ── Runtime MCP wiring ──────────────────────────────────────────────
export {
  buildStdioMcpServer,
  consumePlaywrightUnavailable,
  getMcpServersForQuery,
  getNodeMcpServers,
  markPlaywrightUnavailable,
  OPTIONAL_FORUM_MCP_SERVERS,
  registerRuntimeMcpServer,
  setNodeMcpServers,
  setPlaywrightUnavailableNotifier,
} from "#platform/mcp-config";
export type {
  NegotiumNodeModule,
  NegotiumNodeModuleContext,
  NegotiumNodeModuleHandle,
  StartedNegotiumNodeModules,
} from "#platform/modules";
export { startNegotiumNodeModules } from "#platform/modules";
export type { NodeRequestHandler } from "#platform/node-plugins";
export {
  nodeRequestHandlerNames,
  registerNodeRequestHandler,
  runNodeRequestHandlers,
  unregisterNodeRequestHandler,
} from "#platform/node-plugins";
export { killAllPlaywright } from "#platform/playwright/manager";
// ── Query control ───────────────────────────────────────────────────
export {
  abortAllRooms,
  abortRoom,
  cancelDeferredInject,
  getRoomQuery,
  interSessionQueue,
} from "#query/active-rooms";
export { sessionInboxPath } from "#query/session-inbox-path";
export { AbortReason } from "#query/types";
export type { AskPending } from "#runtime/ask-callbacks";
// ── Runtime ─────────────────────────────────────────────────────────
export { registerAskCallback, resolveAskCallback } from "#runtime/ask-callbacks";
export type { IngestAttachmentArgs, IngestedAttachment } from "#runtime/attachments";
export {
  attachmentPromptLine,
  composeAttachmentPrompt,
  ingestAttachment,
} from "#runtime/attachments";
export type { FileHooks } from "#runtime/file-hooks";
export { setFileHooks, storeLocalFileAsUpload } from "#runtime/file-hooks";
export { renderTurnFooter } from "#runtime/footer";
export { flushSessionInbox, startSessionInboxWorker } from "#runtime/inbox";
export type { AiTurnSettlement, AiTurnTopic } from "#runtime/turn-runner";
export {
  deliverAskCallbackToCaller,
  startAiTurn,
  triggerTopicAiTurn,
} from "#runtime/turn-runner";
export { isSensitivePath } from "#security/sensitive-path";
// ── Storage ─────────────────────────────────────────────────────────
export {
  appendApiMessage,
  getAllMessagesForTopic,
  getApiMessage,
} from "#storage/api-messages";
export { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
export {
  clearTopicSessionId,
  findTopicTitleConflict,
  getTopic,
  getTopicByNameForUser,
  getTopicSessionId,
  listTopics,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
export { db } from "#storage/forum-db";
export type { VaultEntry, VaultEntryWithValue } from "#storage/vault";
export {
  normalizeVaultKey,
  validateVaultKey,
  vaultDel,
  vaultHasKey,
  vaultListWithValues,
  vaultSet,
} from "#storage/vault";
export type { RegisterTopicOptions } from "#topics/create";
// ── Topics ──────────────────────────────────────────────────────────
export { registerTopic, TopicValidationError } from "#topics/create";
export {
  createDerivedTopic,
  getTopics,
  isParticipant,
  TopicTitleConflictError,
  updateTopic,
} from "#topics/derive";
export type { DeleteTopicCascadeOptions } from "#topics/lifecycle";
export { deleteTopicCascade, TopicArchiveRequiredError } from "#topics/lifecycle";
export { ensurePersonalGeneral } from "#topics/personal-general";
// ── Types ───────────────────────────────────────────────────────────
export * from "#types";
export type {
  AiMode,
  AttachmentDto,
  MessageDto,
  ResponsePolicy,
  SubagentCardDto,
  TopicDto,
  TopicKind,
} from "#types/api";
export { syncMetaSkills } from "#workspace/sync";
