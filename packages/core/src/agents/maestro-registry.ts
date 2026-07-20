/**
 * Maestro agent registry — local re-export of `maestro-agent-sdk` with
 * a project-specific default-model override.
 *
 * Mirrors the pattern of claude-registry.ts / codex-registry.ts so that
 * agents/registry.ts can resolve all three AgentRegistry instances from
 * sibling `@/agents/*` paths, keeping the import topology consistent.
 *
 * maestro-agent-sdk v0.1.46 supports DeepSeek and Kimi (Moonshot AI). The
 * SDK's own default is `deepseek-pro`, which matches this override. Negotium
 * intentionally does not expose the retired DeepSeek Flash aliases.
 */
import "#platform/maestro-bootstrap-env";
import {
  setConversationReader,
  maestroRegistry as upstreamMaestroRegistry,
} from "maestro-agent-sdk";
import type { AgentRegistry } from "#agents/contracts";
import { readConversation } from "#storage/conversations";

const DISABLED_MODEL_ALIASES = new Set(["deepseek", "deepseek-flash", "deepseek-v4-flash"]);

const upstream = upstreamMaestroRegistry as AgentRegistry;

// The SDK intentionally defaults its conversation reader to `() => []` so it
// can stay storage-agnostic. Wire Negotium's unified log into it once at module
// load; otherwise Maestro forkSession() creates a valid but empty rollout.
setConversationReader(readConversation as Parameters<typeof setConversationReader>[0]);

export const maestroRegistry: AgentRegistry = {
  ...upstream,
  defaultModel: "deepseek-pro",
  validateModel(model) {
    return !DISABLED_MODEL_ALIASES.has(model) && upstream.validateModel(model);
  },
};
