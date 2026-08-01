import { claudeRegistry, claudeRegistryOperations } from "#agents/claude-registry";
import { codexRegistry, codexRegistryOperations } from "#agents/codex-registry";
import type { AgentRegistry, AgentRegistryOperations } from "#agents/contracts";
import { maestroRegistry, maestroRegistryOperations } from "#agents/maestro-registry";
import type { AgentKind } from "#types";

export type {
  AgentRegistry,
  AgentRegistryOperations,
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

const OPERATIONS: Record<AgentKind, AgentRegistryOperations> = {
  claude: claudeRegistryOperations,
  codex: codexRegistryOperations,
  maestro: maestroRegistryOperations,
};

export function getRegistryOperations(agent: AgentKind): AgentRegistryOperations {
  return OPERATIONS[agent];
}
