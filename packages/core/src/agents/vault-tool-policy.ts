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
