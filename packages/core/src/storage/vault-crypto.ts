import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { VAULT_MASTER_KEY } from "#platform/config";

const ENVELOPE_PREFIX = "otium-vault:v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function encryptionKey(): Buffer {
  return createHash("sha256")
    .update("otium-vault-value-v1\0", "utf8")
    .update(VAULT_MASTER_KEY, "utf8")
    .digest()
    .subarray(0, KEY_BYTES);
}

function aad(userId: string, key: string): Buffer {
  return Buffer.from(`${userId}\0${key.toUpperCase()}`, "utf8");
}

export function isEncryptedVaultValue(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/** Encrypt one vault row. The user/key binding prevents ciphertext row swapping. */
export function encryptVaultValue(userId: string, key: string, value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(aad(userId, key));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

/**
 * Decrypt a stored value. Plaintext rows are accepted for rolling upgrades and
 * are re-encrypted by the storage layer immediately after a successful read.
 */
export function decryptVaultValue(
  userId: string,
  key: string,
  storedValue: string,
): { value: string; legacyPlaintext: boolean } {
  if (!isEncryptedVaultValue(storedValue)) {
    return { value: storedValue, legacyPlaintext: true };
  }

  const encoded = storedValue.slice(ENVELOPE_PREFIX.length);
  const [ivPart, ciphertextPart, tagPart, ...extra] = encoded.split(".");
  if (!ivPart || ciphertextPart === undefined || !tagPart || extra.length > 0) {
    throw new Error("Invalid encrypted vault value");
  }

  const iv = Buffer.from(ivPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error("Invalid encrypted vault value");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAAD(aad(userId, key));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { value: plaintext.toString("utf8"), legacyPlaintext: false };
}
