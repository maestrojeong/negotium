import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, VAULT_MASTER_KEY } from "#platform/config";
import { Database } from "#storage/sqlite";
import { decryptVaultValue, encryptVaultValue } from "#storage/vault-crypto";

export type VaultDatabase = Pick<InstanceType<typeof Database>, "exec" | "prepare">;

export interface VaultStorageOptions {
  database?: VaultDatabase;
  dataDir?: string;
  masterKey?: string;
}

let vaultDb: VaultDatabase | undefined;
let vaultMasterKey = VAULT_MASTER_KEY;

function initializeVaultDatabase(database: VaultDatabase): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
  CREATE TABLE IF NOT EXISTS vault (
    user_id     TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, key)
  )
  `);

  // Migrate legacy schema where user_id was INTEGER (Telegram numeric ids only).
  // The Otium API authenticates with string user ids ("otium-user-…"), so user_id
  // is now TEXT for every channel. Rebuild + CAST existing rows so old Telegram
  // secrets survive; idempotent (no-op once user_id is already TEXT).
  {
    const cols = database.prepare("PRAGMA table_info(vault)").all() as {
      name: string;
      type: string;
    }[];
    const uid = cols.find((c) => c.name === "user_id");
    if (uid && uid.type.toUpperCase() === "INTEGER") {
      database.exec("BEGIN");
      database.exec(`
      CREATE TABLE vault_migrated (
        user_id     TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        value       TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, key)
      )
    `);
      database.exec(
        "INSERT INTO vault_migrated SELECT CAST(user_id AS TEXT), key, value, description FROM vault",
      );
      database.exec("DROP TABLE vault");
      database.exec("ALTER TABLE vault_migrated RENAME TO vault");
      database.exec("COMMIT");
    }
  }
}

function openVaultDatabase(dataDir: string): VaultDatabase {
  const path = join(dataDir, "vault.db");
  mkdirSync(dataDir, { recursive: true });
  const database = new Database(path, { create: true });
  // Defense in depth: the database and its sidecars are owner-only, while each
  // value is also encrypted independently by vault-crypto.
  chmodSync(path, 0o600);
  initializeVaultDatabase(database);
  return database;
}

function activeVaultDatabase(): VaultDatabase {
  if (!vaultDb) vaultDb = openVaultDatabase(DATA_DIR);
  return vaultDb;
}

/** Configure process-wide vault storage during embedding-host bootstrap. */
export function configureVaultStorage(options: VaultStorageOptions): () => void {
  if (options.database && options.dataDir) {
    throw new Error("configureVaultStorage accepts either database or dataDir, not both");
  }
  const previousDb = vaultDb;
  const previousMasterKey = vaultMasterKey;
  const configuredDb = options.database ?? openVaultDatabase(options.dataDir ?? DATA_DIR);
  if (options.database) initializeVaultDatabase(configuredDb);
  vaultDb = configuredDb;
  vaultMasterKey = options.masterKey ?? VAULT_MASTER_KEY;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (!options.database && "close" in configuredDb) {
      (configuredDb as VaultDatabase & { close(): void }).close();
    }
    vaultDb = previousDb;
    vaultMasterKey = previousMasterKey;
  };
}

export interface VaultEntry {
  key: string;
  description: string;
}

export interface VaultEntryWithValue extends VaultEntry {
  value: string;
}

export const VAULT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const VAULT_VALUE_MIN_BYTES = 4;
export const VAULT_VALUE_MAX_BYTES = 64 * 1024;
export const VAULT_DESCRIPTION_MAX_LENGTH = 500;

export function normalizeVaultKey(key: string): string {
  return key.trim().toUpperCase();
}

export function validateVaultKey(key: string): boolean {
  return VAULT_KEY_PATTERN.test(normalizeVaultKey(key));
}

function decryptRow(userId: string, key: string, storedValue: string): string {
  const database = activeVaultDatabase();
  const decoded = decryptVaultValue(userId, key, storedValue, vaultMasterKey);
  if (decoded.legacyPlaintext) {
    database
      .prepare("UPDATE vault SET value = ? WHERE user_id = ? AND key = ? AND value = ?")
      .run(encryptVaultValue(userId, key, decoded.value, vaultMasterKey), userId, key, storedValue);
  }
  return decoded.value;
}

export function vaultListWithValues(userId: string): VaultEntryWithValue[] {
  const rows = activeVaultDatabase()
    .prepare("SELECT key, description, value FROM vault WHERE user_id = ? ORDER BY key")
    .all(userId) as VaultEntryWithValue[];
  return rows.map((row) => ({
    key: row.key,
    description: row.description,
    value: decryptRow(userId, row.key, row.value),
  }));
}

export function vaultSet(userId: string, key: string, value: string, description = ""): void {
  const normalizedKey = normalizeVaultKey(key);
  activeVaultDatabase()
    .prepare(
      `INSERT INTO vault (user_id, key, value, description) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, key) DO UPDATE
         SET value = excluded.value, description = excluded.description`,
    )
    .run(
      userId,
      normalizedKey,
      encryptVaultValue(userId, normalizedKey, value, vaultMasterKey),
      description,
    );
}

export function vaultHasKey(userId: string, key: string): boolean {
  const row = activeVaultDatabase()
    .prepare("SELECT 1 FROM vault WHERE user_id = ? AND key = ?")
    .get(userId, normalizeVaultKey(key));
  return row != null;
}

export function vaultDel(userId: string, key: string): boolean {
  const result = activeVaultDatabase()
    .prepare("DELETE FROM vault WHERE user_id = ? AND key = ?")
    .run(userId, normalizeVaultKey(key)) as { changes: number };
  return result.changes > 0;
}

export function vaultDeleteAllForUser(userId: string): number {
  const result = activeVaultDatabase()
    .prepare("DELETE FROM vault WHERE user_id = ?")
    .run(userId) as {
    changes: number;
  };
  return result.changes;
}

export function vaultList(userId: string): VaultEntry[] {
  return activeVaultDatabase()
    .prepare("SELECT key, description FROM vault WHERE user_id = ? ORDER BY key")
    .all(userId) as VaultEntry[];
}

export function vaultGetValue(userId: string, key: string): string | undefined {
  const normalizedKey = normalizeVaultKey(key);
  const row = activeVaultDatabase()
    .prepare("SELECT key, value FROM vault WHERE user_id = ? AND key = ?")
    .get(userId, normalizedKey) as { key: string; value: string } | undefined;
  return row ? decryptRow(userId, row.key, row.value) : undefined;
}

export interface VaultSubstitutionResult {
  text: string;
  usedKeys: string[];
}

/** Replace {{KEY}} placeholders and report which credentials were consumed. */
export function vaultSubstituteDetailed(userId: string, text: string): VaultSubstitutionResult {
  const entries = new Map(vaultListWithValues(userId).map((entry) => [entry.key, entry.value]));
  const usedKeys = new Set<string>();
  const substituted = text.replace(/\{\{([^}]+)\}\}/g, (match, rawKey: string) => {
    const key = normalizeVaultKey(rawKey);
    const value = entries.get(key);
    if (value === undefined) return match;
    usedKeys.add(key);
    return value;
  });
  return { text: substituted, usedKeys: [...usedKeys] };
}

/** Detect real {{KEY}} references without decrypting any Vault values. */
export function valueReferencesVaultKey(userId: string, value: unknown): boolean {
  const keys = new Set(vaultList(userId).map((entry) => entry.key));
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (keys.has(normalizeVaultKey(match[1] ?? ""))) return true;
      }
      return false;
    }
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate && typeof candidate === "object") {
      return Object.values(candidate as Record<string, unknown>).some(visit);
    }
    return false;
  };
  return visit(value);
}

function encodedSecretForms(value: string): string[] {
  const forms = new Set<string>([
    value,
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    Buffer.from(value, "utf8").toString("hex"),
  ]);
  forms.delete("");
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Scrub raw and common encoded forms before tool output reaches a model. */
export function redactVaultSecrets(userId: string, text: string): string {
  const candidates = vaultListWithValues(userId)
    .flatMap((entry) => encodedSecretForms(entry.value).map((form) => ({ form, key: entry.key })))
    .sort((a, b) => b.form.length - a.form.length || a.key.localeCompare(b.key));
  if (candidates.length === 0) return text;
  const candidatesByFirstCharacter = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const first = candidate.form[0];
    if (!first) continue;
    const bucket = candidatesByFirstCharacter.get(first) ?? [];
    bucket.push(candidate);
    candidatesByFirstCharacter.set(first, bucket);
  }

  let redacted = "";
  let offset = 0;
  while (offset < text.length) {
    const match = candidatesByFirstCharacter
      .get(text[offset] ?? "")
      ?.find((candidate) => text.startsWith(candidate.form, offset));
    if (!match) {
      redacted += text[offset];
      offset += 1;
      continue;
    }
    redacted += `[REDACTED:${match.key}]`;
    offset += match.form.length;
  }
  return redacted;
}
