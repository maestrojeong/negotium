import { VAULT_MASTER_KEY } from "#platform/config";
import {
  decryptVaultValueWithKey,
  encryptVaultValueWithKey,
  isEncryptedVaultValue,
} from "#storage/vault-crypto-core";

export { isEncryptedVaultValue };

/** Encrypt one vault row. The user/key binding prevents ciphertext row swapping. */
export function encryptVaultValue(
  userId: string,
  key: string,
  value: string,
  masterKey = VAULT_MASTER_KEY,
): string {
  return encryptVaultValueWithKey(userId, key, value, masterKey);
}

/**
 * Decrypt a stored value. Plaintext rows are accepted for rolling upgrades and
 * are re-encrypted by the storage layer immediately after a successful read.
 */
export function decryptVaultValue(
  userId: string,
  key: string,
  storedValue: string,
  masterKey = VAULT_MASTER_KEY,
): { value: string; legacyPlaintext: boolean } {
  return decryptVaultValueWithKey(userId, key, storedValue, masterKey);
}
