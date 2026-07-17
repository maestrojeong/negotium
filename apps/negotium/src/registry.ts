import {
  type AgentRegistry,
  type CleanupRolloutsOptions,
  type ForkRegistryOptions,
  type ForkRegistryResult,
  getRegistry as resolveCoreRegistry,
  type WriteRolloutOptions,
  type WriteRolloutResult,
} from "@negotium/core/registry";

export type {
  AgentRegistry,
  CleanupRolloutsOptions,
  ForkRegistryOptions,
  ForkRegistryResult,
  WriteRolloutOptions,
  WriteRolloutResult,
};

export const getRegistry: typeof resolveCoreRegistry = (agent) => resolveCoreRegistry(agent);
