import { isSensitivePath } from "#security/sensitive-path";

const SENSITIVE_RUNTIME_NAMES = [
  "vault.db",
  "vault-master-key",
  "runtime-mcp-secret",
  "sessions.db",
] as const;

// Direct substitution is deliberately default-deny. These provider-owned
// execution tools consume credentials transiently; persistence and messaging
// tools must keep placeholders unresolved.
const DIRECT_VAULT_EXECUTION_TOOLS = new Set(["Bash", "WebFetch"]);

function leafToolName(toolName: string): string {
  const parts = toolName.split("__");
  return parts.at(-1) ?? toolName;
}

export function shouldSubstituteVaultToolInput(toolName: string): boolean {
  const leaf = leafToolName(toolName);
  return leaf.startsWith("browser_") || DIRECT_VAULT_EXECUTION_TOOLS.has(leaf);
}

export const VAULT_BROKER_REDIRECT_ERROR =
  "Vault broker redirection is disabled; use {{KEY}} directly in normal tool inputs.";

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
    // Kept as a compatibility surface for embedding hosts that implemented the
    // pre-0.1.20 broker-only policy. Normal tools now receive Vault values from
    // the execution-time substitution hook, so redirecting a {{KEY}} call
    // would only make browser form filling and other interactive tools fail.
    void userId;
    void toolName;
    void input;
    return false;
  }

  return { isVaultBrokerTool, referencesRuntimeSecretStorage, shouldRedirectVaultTool };
}

const defaultVaultToolPolicy = createVaultToolPolicy({
  isSensitivePath,
  valueReferencesVaultKey: () => false,
});

export const isVaultBrokerTool = defaultVaultToolPolicy.isVaultBrokerTool;
export const referencesRuntimeSecretStorage = defaultVaultToolPolicy.referencesRuntimeSecretStorage;
export const shouldRedirectVaultTool = defaultVaultToolPolicy.shouldRedirectVaultTool;
