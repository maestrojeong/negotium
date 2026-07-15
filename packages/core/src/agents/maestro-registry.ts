/**
 * Maestro agent registry — local re-export of `maestro-agent-sdk` with
 * a project-specific default-model override.
 *
 * Mirrors the pattern of claude-registry.ts / codex-registry.ts so that
 * agents/registry.ts can resolve all three AgentRegistry instances from
 * sibling `@/agents/*` paths, keeping the import topology consistent.
 *
 * maestro-agent-sdk v0.1.39 is DeepSeek-only — the Anthropic and Codex
 * providers were removed. The SDK's own default is `deepseek-pro`, which
 * matches this override. The override is kept explicit so the intent is
 * clear if the upstream default ever changes; users can still switch to
 * `deepseek-flash` per-topic via `/model deepseek-flash`.
 */
import "#platform/maestro-bootstrap-env";
import {
  setConversationReader,
  maestroRegistry as upstreamMaestroRegistry,
} from "maestro-agent-sdk";
import type { AgentRegistry } from "#agents/contracts";
import { readConversation } from "#storage/conversations";

// The SDK intentionally defaults its conversation reader to `() => []` so it
// can stay storage-agnostic. Wire Negotium's unified log into it once at module
// load; otherwise Maestro forkSession() creates a valid but empty rollout.
setConversationReader(readConversation as Parameters<typeof setConversationReader>[0]);

export const maestroRegistry: AgentRegistry = {
  ...(upstreamMaestroRegistry as AgentRegistry),
  defaultModel: "deepseek-pro",
};
