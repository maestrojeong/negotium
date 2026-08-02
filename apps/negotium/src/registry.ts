import {
  type AgentRegistry,
  type AgentRegistryOperations,
  type CleanupRolloutsOptions,
  type ForkRegistryOptions,
  type ForkRegistryResult,
  getRegistry as resolveCoreRegistry,
  getRegistryOperations as resolveCoreRegistryOperations,
  type WriteRolloutOptions,
  type WriteRolloutResult,
} from "@negotium/core/registry";

export type {
  AgentRegistry,
  AgentRegistryOperations,
  CleanupRolloutsOptions,
  ForkRegistryOptions,
  ForkRegistryResult,
  WriteRolloutOptions,
  WriteRolloutResult,
};

export const getRegistry: typeof resolveCoreRegistry = (agent) => resolveCoreRegistry(agent);

export const getRegistryOperations: typeof resolveCoreRegistryOperations = (agent) =>
  resolveCoreRegistryOperations(agent);
