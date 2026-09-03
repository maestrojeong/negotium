/** Stable core surface used by the embedded runtime MCP endpoint. */
export { createAskUserToolDefinition } from "#agents/mcp-tools/ask-user";
export { errorResult, textResult } from "#agents/mcp-tools/common";
export { createPublishHtmlToolDefinitions } from "#agents/mcp-tools/publish-html";
export type { SelfConfigContext } from "#agents/mcp-tools/self-config";
export { createSelfConfigToolDefinitions } from "#agents/mcp-tools/self-config";
export {
  canSpawnSubagentsFromTopic,
  createPrepareSubagentToolDefinition,
  createSpawnSubagentToolDefinition,
  createSubagentManagementToolDefinitions,
} from "#agents/mcp-tools/spawn-subagent";
export { showPngTool } from "#agents/mcp-tools/visual-compat";
export { visualToolDefinitions } from "#agents/mcp-tools/visuals";
export { WsHub } from "#bus";
export {
  dispatchPeerRuntimeAskUser,
  dispatchPeerRuntimeFile,
  dispatchPeerRuntimeSelfConfig,
  dispatchPeerRuntimeSpawn,
} from "#mcp/peer-bridge";
export type { HostedMcpContext, HostedMcpSurface, RuntimeMcpContext } from "#mcp/runtime-spec";
export {
  buildHostedMcpSpec,
  buildRuntimeMcpSpec,
  HOSTED_MCP_SURFACES,
  isHostedMcpSurface,
  RUNTIME_MCP_BASE_PATH,
  RUNTIME_MCP_KEY,
  resolveHostedMcpToken,
  resolveRuntimeMcpToken,
} from "#mcp/runtime-spec";
export { WORKSPACE_DIR } from "#platform/config";
export { FROM_AUTO_CONTINUE, NODE_LOCAL_USER_ID } from "#platform/constants";
export { errMsg } from "#platform/error";
export { appendJsonlEntry } from "#platform/jsonl";
export { logger } from "#platform/logger";
export { OPTIONAL_FORUM_MCP_SERVERS, REQUIRED_FORUM_MCP_SERVERS } from "#platform/mcp-config";
export { abortRoom, getRoomQuery } from "#query/active-rooms";
export { sessionInboxPath } from "#query/session-inbox-path";
export { prepareDeliveryAck } from "#runtime/delivery-ack";
export { storeLocalFileAsUpload } from "#runtime/file-hooks";
export {
  renderThreadForModel,
  renderTopicThreadList,
  THREAD_READ_DEFAULT_LIMIT,
  THREAD_READ_MAX_LIMIT,
} from "#runtime/thread-read";
export { isSensitivePath } from "#security/sensitive-path";
export {
  appendApiMessage,
  findThreadRootsByPrefix,
  listTopicThreadRoots,
} from "#storage/api-messages";
export { getApiTopicConfig } from "#storage/api-topic-config";
export { defaultTopicSurface, getTopic, getTopicByNameForUser } from "#storage/api-topics";
export { enqueueSessionInbox } from "#storage/session-inbox";
export { registerTopic, TopicValidationError } from "#topics/create";
export {
  getTopics,
  isParticipant,
} from "#topics/derive";
export {
  deleteTopicCascade,
  TopicArchiveRequiredError,
  TopicCleanupRequiredError,
} from "#topics/lifecycle";
export { restartTopicSession } from "#topics/session";
export type { EffortLevel } from "#types";
export { EFFORT_VALUES } from "#types";
export type { MessageDto, TopicDto, TopicSurface } from "#types/api";
