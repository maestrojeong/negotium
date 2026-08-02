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
  CodexPatchChangePreview,
  CodexPatchPreview,
  CodexRolloutOptions,
  CodexRolloutResult,
  RolloutHostOptions,
} from "@negotium/core/rollout";

export const configureRolloutHost = coreRollout.configureRolloutHost;
export const decodeUuidV7Timestamp = coreRollout.decodeUuidV7Timestamp;
export const encodeClaudeCwd = coreRollout.encodeClaudeCwd;
export const extractCodexPatchCallIds = coreRollout.extractCodexPatchCallIds;
export const extractChatPairs = coreRollout.extractChatPairs;
export const extractLatestCodexContextUsage = coreRollout.extractLatestCodexContextUsage;
export const extractLatestCodexPatchPreview = coreRollout.extractLatestCodexPatchPreview;
export const migrateCodexRolloutNativeMultiAgentMetadata =
  coreRollout.migrateCodexRolloutNativeMultiAgentMetadata;
export const readCodexPatchCallIds = coreRollout.readCodexPatchCallIds;
export const readLatestCodexContextUsage = coreRollout.readLatestCodexContextUsage;
export const readLatestCodexPatchPreview = coreRollout.readLatestCodexPatchPreview;
export const repairPoisonedRollout = coreRollout.repairPoisonedRollout;
export const writeClaudeRollout = coreRollout.writeClaudeRollout;
export const writeCodexRollout = coreRollout.writeCodexRollout;
