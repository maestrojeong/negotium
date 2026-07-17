import {
  referencesRuntimeSecretStorage as defaultReferencesRuntimeSecretStorage,
  shouldRedirectVaultTool as defaultShouldRedirectVaultTool,
} from "#agents/vault-tool-policy";
import { CLAUDE_EXECUTABLE, codexAuthFilePath } from "#platform/config";
import { getMcpServersForQuery as defaultGetMcpServersForQuery } from "#platform/mcp-config";
import { redactVaultSecrets as defaultRedactVaultSecrets } from "#storage/vault";
import type { AgentQueryOptions } from "#types";

/**
 * Host-owned services used by the provider execution layer.
 *
 * The default implementation preserves standalone Negotium behaviour. An
 * embedding host may replace these callbacks once during process bootstrap so
 * providers use that host's MCP catalog and device-local secret store without
 * importing any host-specific runtime code into Negotium.
 */
export interface AgentExecutionHost {
  getMcpServersForQuery(opts: AgentQueryOptions): Record<string, unknown>;
  redactVaultSecrets(userId: string, value: string): string;
  referencesRuntimeSecretStorage(value: unknown): boolean;
  shouldRedirectVaultTool(userId: string, toolName: string, input: unknown): boolean;
  claudeCodeExecutablePath(): string | undefined;
  codexAuthFilePath(): string;
  transformQueryOptions?(opts: AgentQueryOptions): AgentQueryOptions;
}

const defaultHost: AgentExecutionHost = {
  getMcpServersForQuery: defaultGetMcpServersForQuery,
  redactVaultSecrets: defaultRedactVaultSecrets,
  referencesRuntimeSecretStorage: defaultReferencesRuntimeSecretStorage,
  shouldRedirectVaultTool: defaultShouldRedirectVaultTool,
  claudeCodeExecutablePath: () => CLAUDE_EXECUTABLE,
  codexAuthFilePath,
};

const hostRegistrations: Array<{
  id: symbol;
  overrides: Partial<AgentExecutionHost>;
}> = [];

function activeHost(): AgentExecutionHost {
  const host = { ...defaultHost };
  for (const registration of hostRegistrations) Object.assign(host, registration.overrides);
  return host;
}

/** Configure provider host services. Returns a disposer useful for tests. */
export function configureAgentExecutionHost(overrides: Partial<AgentExecutionHost>): () => void {
  const registration = { id: Symbol("agent-execution-host"), overrides };
  hostRegistrations.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = hostRegistrations.findIndex((entry) => entry.id === registration.id);
    if (index >= 0) hostRegistrations.splice(index, 1);
  };
}

export function hostedMcpServers(opts: AgentQueryOptions): Record<string, unknown> {
  return activeHost().getMcpServersForQuery(opts);
}

export function redactHostedSecrets(userId: string, value: string): string {
  return activeHost().redactVaultSecrets(userId, value);
}

export function referencesHostedSecretStorage(value: unknown): boolean {
  return activeHost().referencesRuntimeSecretStorage(value);
}

export function shouldRedirectHostedVaultTool(
  userId: string,
  toolName: string,
  input: unknown,
): boolean {
  return activeHost().shouldRedirectVaultTool(userId, toolName, input);
}

export function transformHostedQueryOptions(opts: AgentQueryOptions): AgentQueryOptions {
  return activeHost().transformQueryOptions?.(opts) ?? opts;
}

export function hostedClaudeCodeExecutablePath(): string | undefined {
  return activeHost().claudeCodeExecutablePath();
}

export function hostedCodexAuthFilePath(): string {
  return activeHost().codexAuthFilePath();
}
