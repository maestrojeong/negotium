import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// --- Sensitive path blacklist ---

const SENSITIVE_PATH_PATTERNS = [
  /\/\.env(\.|$)/i,
  /\/\.ssh\//i,
  /\/\.aws\//i,
  /\/\.gnupg\//i,
  /\/\.netrc$/i,
  /\/\.npmrc$/i,
  /\/(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|cer|crt)$/i,
  /\/Library\/Keychains\//i,
  // Runtime-owned stores and key material. Vault values are encrypted, but
  // exposing ciphertext or its master key to an agent defeats that boundary.
  /\/vault\.db(-wal|-shm|-journal)?$/i,
  /\/vault-master-key$/i,
  /\/runtime-mcp-secret$/i,
  /\/sessions\.db(-wal|-shm|-journal)?$/i,
];

export function isSensitivePath(filePath: string): boolean {
  const normalized = resolve(filePath);
  if (SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized))) return true;
  try {
    const real = realpathSync(normalized);
    if (real !== normalized) return SENSITIVE_PATH_PATTERNS.some((p) => p.test(real));
  } catch {
    // File doesn't exist — no symlink concern
  }
  return false;
}
