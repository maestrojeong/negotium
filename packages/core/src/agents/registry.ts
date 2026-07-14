import { claudeRegistry } from "#agents/claude-registry";
import { codexRegistry } from "#agents/codex-registry";
import type { AgentRegistry } from "#agents/contracts";
import { maestroRegistry } from "#agents/maestro-registry";
import type { AgentKind } from "#types";

export type {
  AgentRegistry,
  CleanupRolloutsOptions,
  ForkRegistryOptions,
  ForkRegistryResult,
  WriteRolloutOptions,
  WriteRolloutResult,
} from "#agents/contracts";

const REGISTRIES: Record<AgentKind, AgentRegistry> = {
  claude: claudeRegistry,
  codex: codexRegistry,
  maestro: maestroRegistry,
};

export function getRegistry(agent: AgentKind): AgentRegistry {
  return REGISTRIES[agent];
}
