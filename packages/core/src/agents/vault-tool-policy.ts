import { isSensitivePath } from "#security/sensitive-path";
import { valueReferencesVaultKey } from "#storage/vault";

const SENSITIVE_RUNTIME_NAMES = [
  "vault.db",
  "vault-master-key",
  "runtime-mcp-secret",
  "sessions.db",
] as const;

export const VAULT_BROKER_REDIRECT_ERROR =
  "Vault placeholders must be executed through mcp__vault__vault_run (shell/CLI) or mcp__vault__vault_http_request (HTTP) so secret values cannot enter the model transcript.";

export interface VaultToolPolicyHost {
  isSensitivePath(path: string): boolean;
  valueReferencesVaultKey(userId: string, value: unknown): boolean;
}

export interface VaultToolPolicy {
  isVaultBrokerTool(toolName: string): boolean;
  referencesRuntimeSecretStorage(value: unknown): boolean;
  shouldRedirectVaultTool(userId: string, toolName: string, input: unknown): boolean;
}

export function createVaultToolPolicy(host: VaultToolPolicyHost): VaultToolPolicy {
  function isVaultBrokerTool(toolName: string): boolean {
    return toolName.includes("vault_run") || toolName.includes("vault_http_request");
  }

  function referencesRuntimeSecretStorage(value: unknown): boolean {
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (SENSITIVE_RUNTIME_NAMES.some((name) => lower.includes(name))) return true;
      return value.startsWith("/") && host.isSensitivePath(value);
    }
    if (Array.isArray(value)) return value.some(referencesRuntimeSecretStorage);
    if (value && typeof value === "object") {
      return Object.values(value as Record<string, unknown>).some(referencesRuntimeSecretStorage);
    }
    return false;
  }

  function shouldRedirectVaultTool(userId: string, toolName: string, input: unknown): boolean {
    return !isVaultBrokerTool(toolName) && host.valueReferencesVaultKey(userId, input);
  }

  return { isVaultBrokerTool, referencesRuntimeSecretStorage, shouldRedirectVaultTool };
}

const defaultVaultToolPolicy = createVaultToolPolicy({ isSensitivePath, valueReferencesVaultKey });

export const isVaultBrokerTool = defaultVaultToolPolicy.isVaultBrokerTool;
export const referencesRuntimeSecretStorage = defaultVaultToolPolicy.referencesRuntimeSecretStorage;
export const shouldRedirectVaultTool = defaultVaultToolPolicy.shouldRedirectVaultTool;
