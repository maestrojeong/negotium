/**
 * @negotium/core public API.
 *
 * Hosts embed the runtime through this barrel: create/list topics, trigger
 * turns, subscribe to the RuntimeBus, and mount MCP catalogs for agent turns.
 * Deep imports are not part of the public contract.
 */

import "#platform/maestro-bootstrap-env";

// ── Agents ──────────────────────────────────────────────────────────
export { checkAgentAuth } from "#agents/auth-check";
export { killOwnedCodexTreesForShutdown } from "#agents/codex-tree-kill";
export type { ForkHandle } from "#agents/fork";
export { cleanupAgentFork, forkAgentSession } from "#agents/fork";
export { runAgent, SUPPORTED_AGENTS } from "#agents/index";
export type { AnswerAskUserQuestionResult } from "#agents/mcp-tools/ask-user";
export {
  answerPendingAskUserQuestion,
  createAskUserToolDefinition,
} from "#agents/mcp-tools/ask-user";
export type { McpToolResult, SharedMcpTool } from "#agents/mcp-tools/common";
export { errorResult, textResult } from "#agents/mcp-tools/common";
export type { SelfConfigContext } from "#agents/mcp-tools/self-config";
export { createSelfConfigToolDefinitions } from "#agents/mcp-tools/self-config";
export {
  createSpawnSubagentToolDefinition,
  createSubagentManagementToolDefinitions,
  sweepStaleSubagentCards,
} from "#agents/mcp-tools/spawn-subagent";
export { visualToolDefinitions } from "#agents/mcp-tools/visuals";
export {
  AGENT_DISPLAY_NAME,
  modelOwner,
  resolveModelForAgent,
  SELECTABLE_MODELS,
  selectableModel,
} from "#agents/model-catalog";
export { getRegistry } from "#agents/registry";
export type {
  PurgeSessionRef,
  PurgeTopicLogsOptions,
  RotateTopicLogsOptions,
  RotateTopicLogsResult,
} from "#agents/topic-cleanup";
export { purgeTopicLogs, rotateTopicLogs } from "#agents/topic-cleanup";
// ── Application use cases ──────────────────────────────────────────
export type { ExecuteExternalUserTurnParams } from "#application/execute-external-user-turn";
export { executeExternalUserTurn } from "#application/execute-external-user-turn";
export type {
  SubmitUserMessageParams,
  SubmitUserMessageResult,
} from "#application/submit-user-message";
export { submitUserMessage } from "#application/submit-user-message";
export type {
  SwitchTopicAccessModeParams,
  SwitchTopicAccessModeResult,
} from "#application/switch-topic-access-mode";
export { switchTopicAccessMode } from "#application/switch-topic-access-mode";
export type {
  SwitchTopicEffortParams,
  SwitchTopicEffortResult,
} from "#application/switch-topic-effort";
export { switchTopicEffort } from "#application/switch-topic-effort";
export type {
  SwitchTopicModelParams,
  SwitchTopicModelResult,
} from "#application/switch-topic-model";
export { switchTopicModel } from "#application/switch-topic-model";
export type {
  CompactUserTopicParams,
  DeleteUserTopicParams,
  DeriveUserTopicParams,
  TopicServiceErrorCode,
  TopicSessionParams,
} from "#application/topic-service";
export { TopicServiceError, topicService } from "#application/topic-service";
export {
  deleteVaultEntry,
  executeVaultCommand,
  isVaultCommandLine,
  listVaultEntries,
  type SaveVaultEntryResult,
  saveVaultEntry,
  VAULT_COMMAND_HELP,
} from "#application/vault-command";
// ── Host boundary ───────────────────────────────────────────────────
export type { RuntimeBus, RuntimeBusEvent, RuntimeBusListener } from "#bus";
export { runtimeBus, setRuntimeBus, WsHub } from "#bus";
export type {
  PeerRuntimeAskUserRequest,
  PeerRuntimeBridge,
  PeerRuntimeFileRequest,
  PeerRuntimeSelfConfigRequest,
  PeerRuntimeSpawnRequest,
  PeerRuntimeVisualRequest,
  PeerRuntimeVisualResult,
} from "#mcp/peer-bridge";
export {
  dispatchPeerRuntimeAskUser,
  dispatchPeerRuntimeFile,
  dispatchPeerRuntimeSelfConfig,
  dispatchPeerRuntimeSpawn,
  dispatchPeerRuntimeVisual,
  flushPeerRuntimeEvents,
  registerPeerRuntimeBridge,
} from "#mcp/peer-bridge";
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
export {
  deliverPeerReply,
  type PeerForwardArgs,
  type PeerForwardResult,
  type PeerSessionBridge,
  type RemoteReplyRoute,
  registerPeerSessionBridge,
} from "#mcp/session-comm/peer-forward";
// ── Media ───────────────────────────────────────────────────────────
export { extractFileEvents, extractFileTagPaths, stripFileTags } from "#media/file-events";
export type { ExtractionResult, TranscribeAudioOptions } from "#media/text-extractor";
export { extractText, isTranscriptionConfigured, transcribeAudio } from "#media/text-extractor";
export { killAllBgBash } from "#platform/background-bash/manager";
// ── Platform ────────────────────────────────────────────────────────
export {
  DATA_DIR,
  LOG_DIR,
  MAX_TELL_DEPTH,
  NEGOTIUM_PORT,
  NODE_CONTROL_TOKEN,
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
  isTopicRunning,
  listRunningTopicIds,
  listRunningTopicQueries,
} from "#query/active-rooms";
export { sessionInboxPath } from "#query/session-inbox-path";
export { AbortReason } from "#query/types";
export type { AskPending } from "#runtime/ask-callbacks";
// ── Runtime ─────────────────────────────────────────────────────────
export {
  failInterruptedRemoteAskCallbacks,
  registerAskCallback,
  resolveAskCallback,
} from "#runtime/ask-callbacks";
export type { IngestAttachmentArgs, IngestedAttachment } from "#runtime/attachments";
export {
  attachmentPromptLine,
  composeAttachmentPrompt,
  ingestAttachment,
} from "#runtime/attachments";
export type { BackgroundSessionProvider } from "#runtime/background-sessions";
export {
  backgroundSessionProgress,
  listBackgroundSessionsForUser,
  registerBackgroundSessionProvider,
} from "#runtime/background-sessions";
export type { DeliveryAckResult } from "#runtime/delivery-ack";
export {
  claimDeliveryAck,
  prepareDeliveryAck,
  resolveDeliveryAck,
} from "#runtime/delivery-ack";
export type { FileHooks, UploadAccess } from "#runtime/file-hooks";
export {
  fileHooks,
  resetFileHooks,
  resolveAttachmentByFileId,
  resolveUploadedFilePathByFileId,
  setFileHooks,
  storeLocalFileAsUpload,
} from "#runtime/file-hooks";
export { renderTurnFooter } from "#runtime/footer";
export { flushSessionInbox, startSessionInboxWorker } from "#runtime/inbox";
export type { AiTurnSettlement, AiTurnTopic } from "#runtime/turn-runner";
export {
  deliverAskCallbackToCaller,
  resolveInitialTurnSessionId,
  resolveTopicTurnExecution,
  resolveTopicTurnSession,
  startAiTurn,
  startDurableTurnRequestWorker,
  triggerTopicAiTurn,
} from "#runtime/turn-runner";
export { isSensitivePath } from "#security/sensitive-path";
export type { MessagePage } from "#storage/api-messages";
// ── Storage ─────────────────────────────────────────────────────────
export {
  appendApiMessage,
  getAllMessagesForTopic,
  getApiMessage,
  listApiMessages,
} from "#storage/api-messages";
export { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
export {
  clearTopicSessionId,
  findTopicTitleConflict,
  getTopic,
  getTopicByNameForUser,
  getTopicSessionId,
  isTopicShared,
  isTopicVisible,
  listTopics,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
export { getGlobalAiName } from "#storage/app-settings";
export { db } from "#storage/forum-db";
export type { StoredRuntimeEvent } from "#storage/runtime-events";
export {
  latestRuntimeEventSeq,
  listRecentRuntimeEventsForTopic,
  listRuntimeEventsAfter,
} from "#storage/runtime-events";
export {
  claimRuntimeTurnLease,
  listRuntimeTurnLeases,
  releaseRuntimeTurnLease,
} from "#storage/runtime-leases";
export type {
  AcquireRuntimeProcessLeaseOptions,
  RuntimeProcessLease,
  RuntimeProcessLeaseHandle,
  WaitForRequiredRuntimeProcessLeaseOptions,
  WaitForRuntimeProcessLeaseOptions,
} from "#storage/runtime-process-leases";
export {
  acquireRuntimeProcessLease,
  getRuntimeProcessLease,
  listRuntimeProcessLeases,
  PROCESS_LEASE_HEARTBEAT_MS,
  PROCESS_LEASE_STALE_MS,
  waitForRequiredRuntimeProcessLease,
  waitForRuntimeProcessLease,
} from "#storage/runtime-process-leases";
export { clearPendingAsk } from "#storage/session-asks";
export type { VaultEntry, VaultEntryWithValue } from "#storage/vault";
export {
  normalizeVaultKey,
  VAULT_DESCRIPTION_MAX_LENGTH,
  VAULT_VALUE_MAX_BYTES,
  VAULT_VALUE_MIN_BYTES,
  validateVaultKey,
  vaultDel,
  vaultHasKey,
  vaultList,
  vaultListWithValues,
  vaultSet,
} from "#storage/vault";
export type { RegisterTopicOptions } from "#topics/create";
// ── Topics ──────────────────────────────────────────────────────────
export { registerTopic, TopicValidationError } from "#topics/create";
export {
  createDerivedTopic,
  getTopics,
  getVisibleTopics,
  isParticipant,
  TopicDeriveBusyError,
  TopicTitleConflictError,
  updateTopic,
} from "#topics/derive";
export type { DeleteTopicCascadeOptions } from "#topics/lifecycle";
export {
  deleteTopicCascade,
  TopicArchiveRequiredError,
  TopicTurnStillActiveError,
} from "#topics/lifecycle";
export { ensurePersonalGeneral } from "#topics/personal-general";
export type {
  CompactSummaryRequest,
  CompactTopicSessionOptions,
  RestartTopicSessionResult,
} from "#topics/session";
export { compactTopicSession, restartTopicSession } from "#topics/session";
export * from "#types";
// ── Types ───────────────────────────────────────────────────────────
export { EFFORT_VALUES } from "#types";
export type {
  AiMode,
  AttachmentDto,
  BackgroundSessionDto,
  MessageDto,
  ResponsePolicy,
  SubagentCardDto,
  TopicAccessMode,
  TopicDto,
  TopicKind,
  TopicVisibility,
} from "#types/api";
export { NEGOTIUM_VERSION } from "#version";
