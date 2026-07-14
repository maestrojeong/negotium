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

export function isVaultBrokerTool(toolName: string): boolean {
  return toolName.includes("vault_run") || toolName.includes("vault_http_request");
}

export function referencesRuntimeSecretStorage(value: unknown): boolean {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (SENSITIVE_RUNTIME_NAMES.some((name) => lower.includes(name))) return true;
    return value.startsWith("/") && isSensitivePath(value);
  }
  if (Array.isArray(value)) return value.some(referencesRuntimeSecretStorage);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(referencesRuntimeSecretStorage);
  }
  return false;
}

export function shouldRedirectVaultTool(userId: string, toolName: string, input: unknown): boolean {
  return !isVaultBrokerTool(toolName) && valueReferencesVaultKey(userId, input);
}
