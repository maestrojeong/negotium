/** Stable, daemon-focused core surface. Keep this free of the root barrel. */
export { killOwnedCodexTreesForShutdown } from "#agents/codex-tree-kill";
export {
  reconcilePendingAskUserQuestionGates,
  startAskUserQuestionGateOwner,
  stopAskUserQuestionGateOwner,
} from "#agents/mcp-tools/ask-user";
export { sweepStaleSubagentCards } from "#agents/mcp-tools/spawn-subagent";
export {
  RuntimeGatewayIdempotencyConflictError,
  submitRuntimeGatewayTurn,
} from "#application/submit-runtime-gateway-turn";
export { submitUserMessage } from "#application/submit-user-message";
export { switchTopicEffort } from "#application/switch-topic-effort";
export { switchTopicModel } from "#application/switch-topic-model";
export { TopicServiceError, topicService } from "#application/topic-service";
export {
  deleteVaultEntry,
  executeVaultCommand,
  listVaultEntries,
  saveVaultEntry,
} from "#application/vault-command";
export type { RuntimeBusEvent } from "#bus";
export { runtimeBus, WsHub } from "#bus";
export { setRuntimeMcpPort } from "#mcp/runtime-spec";
export { killAllBgBash } from "#platform/background-bash/manager";
export {
  DATA_DIR,
  NEGOTIUM_PORT,
  NODE_CONTROL_TOKEN,
  NODE_ID,
  RUN_DIR,
  STATE_DIR,
  WORKSPACE_DIR,
} from "#platform/config";
export { onShutdown, runShutdown } from "#platform/lifecycle";
export { logger } from "#platform/logger";
export type { NodeMcpEntry } from "#platform/mcp-config";
export { setNodeMcpServers } from "#platform/mcp-config";
export type {
  NegotiumNodeModule,
  StartedNegotiumNodeModules,
} from "#platform/modules";
export { startNegotiumNodeModules } from "#platform/modules";
export {
  nodeRequestHandlerNames,
  runNodeRequestHandlers,
} from "#platform/node-plugins";
export {
  killAllPlaywright,
  reapPlaywrightOrphans as reapOrphanBrowsers,
} from "#platform/playwright/manager";
export { abortAllRooms, listRunningTopicQueries } from "#query/active-rooms";
export { listBackgroundSessionsForUser } from "#runtime/background-sessions";
export type {
  BashrsCompletion,
  BashrsCompletionSink,
} from "#runtime/bashrs-completions";
export {
  flushBashrsCompletions,
  setBashrsCompletionSink,
  startBashrsCompletionsWorker,
} from "#runtime/bashrs-completions";
export type { FileHooks, UploadAccess } from "#runtime/file-hooks";
export { setFileHooks } from "#runtime/file-hooks";
export { startSessionInboxWorker } from "#runtime/inbox";
export { startAiTurn, startDurableTurnRequestWorker } from "#runtime/turn-runner";
export {
  appendApiMessage,
  getApiMessage,
  getLastMessagePreviews,
  listApiMessages,
} from "#storage/api-messages";
export { getTopic, upsertTopic } from "#storage/api-topics";
export { getGlobalAiName, setGlobalAiName } from "#storage/app-settings";
export { readDecisions, writeDecisionGraphSvg } from "#storage/decisions";
export type { StoredRuntimeEvent } from "#storage/runtime-events";
export {
  latestRuntimeEventSeq,
  listRecentRuntimeEventsForTopic,
  listRuntimeEventsAfter,
} from "#storage/runtime-events";
export { acquireRuntimeProcessLease } from "#storage/runtime-process-leases";
export { getTopicStats } from "#storage/token-stats";
export { TopicValidationError } from "#topics/create";
export {
  getVisibleTopics,
  isParticipant,
  TopicDeriveBusyError,
  TopicForkCompactionError,
  TopicTitleConflictError,
} from "#topics/derive";
export { ensurePersonalGeneral } from "#topics/personal-general";
export { compactTopicSession } from "#topics/session";
export { TopicUpdateConflictError, updateTopicSettings } from "#topics/update";
export type { AgentKind } from "#types";
export type { AiMode, AttachmentDto, TopicDto, TopicSurface } from "#types/api";
export { NEGOTIUM_VERSION } from "#version";
