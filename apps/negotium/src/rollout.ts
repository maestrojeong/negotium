import { fileURLToPath } from "node:url";
import * as coreRollout from "@negotium/core/rollout";

coreRollout.configureRolloutHost({
  fixturesDir: fileURLToPath(new URL("./runtime/src/agents/fixtures", import.meta.url)),
});

export type {
  ChatPair,
  ClaudeRolloutOptions,
  ClaudeRolloutResult,
  CodexContextUsage,
  CodexRolloutOptions,
  CodexRolloutResult,
  RolloutHostOptions,
} from "@negotium/core/rollout";

export const configureRolloutHost = coreRollout.configureRolloutHost;
export const decodeUuidV7Timestamp = coreRollout.decodeUuidV7Timestamp;
export const encodeClaudeCwd = coreRollout.encodeClaudeCwd;
export const extractChatPairs = coreRollout.extractChatPairs;
export const extractLatestCodexContextUsage = coreRollout.extractLatestCodexContextUsage;
export const migrateCodexRolloutNativeMultiAgentMetadata =
  coreRollout.migrateCodexRolloutNativeMultiAgentMetadata;
export const readLatestCodexContextUsage = coreRollout.readLatestCodexContextUsage;
export const repairPoisonedRollout = coreRollout.repairPoisonedRollout;
export const writeClaudeRollout = coreRollout.writeClaudeRollout;
export const writeCodexRollout = coreRollout.writeCodexRollout;
