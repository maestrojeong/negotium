import type { VaultEntry, VaultSubstitutionResult } from "#storage/vault";

export interface VaultCredentialHost {
  list(userId: string): readonly VaultEntry[];
  substitute(userId: string, text: string): VaultSubstitutionResult;
  redact(userId: string, text: string): string;
  log?(level: "info" | "warn", details: Record<string, unknown>, message: string): void;
}
