/** Stable public storage facade for embedding hosts such as Otium. */

// Namespaces preserve each legacy module's exact surface, including names that
// collide across stores (notably forum.getTopicByName and apiTopics.getTopicByName).
export * as activityLog from "#storage/activity-log";
// Direct exports keep common replacements concise. The forum collision is
// exposed as getForumTopicByName; its original name remains under `forum`.
export * from "#storage/activity-log";
export * as apiMessages from "#storage/api-messages";
export * from "#storage/api-messages";
export * as apiTopicBrief from "#storage/api-topic-brief";
export * from "#storage/api-topic-brief";
export * as apiTopicConfig from "#storage/api-topic-config";
export * from "#storage/api-topic-config";
export * as apiTopics from "#storage/api-topics";
export * from "#storage/api-topics";
export * as appSettings from "#storage/app-settings";
export * from "#storage/app-settings";
export * as conversations from "#storage/conversations";
export * from "#storage/conversations";
export type {
  ForumTopicInfo,
  TopicRow,
  UserForumConfig,
  UserRow,
} from "#storage/forum/index";
export * as forum from "#storage/forum/index";
export {
  addTopic,
  clearDmSessionId,
  clearSessionForTopic,
  findUserByThread,
  flushSessionCache,
  getAllTopics,
  getAllUserIds,
  getCommunicateThreadId,
  getDmSessionId,
  getLastShownConfig,
  getSessionForTopic,
  getTopicAgent,
  getTopicByName as getForumTopicByName,
  getTopicDescription,
  getTopicMcpConfig,
  getTopicNames,
  getUserConfig,
  removeTopic,
  renameTopic,
  setDmSessionId,
  setLastShownConfig,
  setSessionForTopic,
  setTopicAgent,
  setTopicDescription,
  setTopicForkOrigin,
  setTopicMcpEnabled,
  setTopicMcpExtra,
  updateTopicThreadId,
} from "#storage/forum/index";
export * as sessionAsks from "#storage/session-asks";
export * from "#storage/session-asks";
export type {
  StorageDatabase,
  StorageDatabaseAdapter,
  StorageDatabaseInput,
  StorageHostConfig,
  StorageHostOptions,
  StorageStatement,
  StorageTransaction,
} from "#storage/storage-contract";
export { configureStorageHost, db, resetStorageHost } from "#storage/storage-public-host";
export * as tasks from "#storage/tasks";
export * from "#storage/tasks";
export * as tokenStats from "#storage/token-stats";
export * from "#storage/token-stats";
export * as topicArchive from "#storage/topic-archive";
export * from "#storage/topic-archive";
export * as topicArchiveState from "#storage/topic-archive-state";
export * from "#storage/topic-archive-state";
export * as topicSettings from "#storage/topic-settings";
export * from "#storage/topic-settings";
export * as topicTranscript from "#storage/topic-transcript";
export * from "#storage/topic-transcript";
export * as wiki from "#storage/wiki";
export * from "#storage/wiki";
export * as wikiSummaryNames from "#storage/wiki-summary-names";
export * from "#storage/wiki-summary-names";
export type { AgentKind, EffortLevel } from "#types";
export type {
  AiMode,
  MessageDto,
  ParticipantDto,
  ResponsePolicy,
  TopicAccessMode,
  TopicDto,
  TopicKind,
  TopicVisibility,
} from "#types/api";
