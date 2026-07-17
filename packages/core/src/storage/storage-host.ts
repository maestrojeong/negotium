import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "#storage/sqlite";

export type StorageDatabase = InstanceType<typeof Database>;

export interface StorageHostOptions {
  /** Borrowed SQLite connection. Negotium never closes an injected database. */
  database?: StorageDatabase;
  /** Persistent JSON/JSONL state root. */
  dataDir?: string;
  /** Activity and token-usage log root. */
  logDir?: string;
  /** Durable ask edge root. Defaults to Negotium's runtime ask directory. */
  sessionAsksDir?: string;
  /** Shared topic workspace root used by wiki/archive helpers. */
  workspaceDir?: string;
}

let configuredHost: Readonly<StorageHostOptions> = {};
let fallbackDatabase: StorageDatabase | null = null;

type StorageSchemaInitializer = (database: StorageDatabase) => void;
interface RegisteredSchemaInitializer {
  initialize: StorageSchemaInitializer;
  priority: number;
}

const schemaInitializers: RegisteredSchemaInitializer[] = [];
const initializedSchemas = new WeakMap<StorageDatabase, Set<StorageSchemaInitializer>>();
const initializingDatabases = new WeakSet<StorageDatabase>();

function envPath(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return resolve(value || fallback);
}

function defaultStateDir(): string {
  return envPath("NEGOTIUM_STATE_DIR", join(homedir(), ".negotium"));
}

function defaultDataDir(): string {
  return envPath("NEGOTIUM_DATA_DIR", join(defaultStateDir(), "data"));
}

function defaultLogDir(): string {
  return envPath("NEGOTIUM_LOG_DIR", join(defaultStateDir(), "logs"));
}

function defaultWorkspaceDir(): string {
  return envPath("NEGOTIUM_WORKSPACE_DIR", join(defaultStateDir(), "workspace"));
}

function defaultSessionAsksDir(): string {
  const runDir = envPath("NEGOTIUM_RUN_DIR", join(defaultStateDir(), "run"));
  return join(runDir, "session-asks");
}

function defaultSessionsDatabasePath(): string {
  return envPath("SESSIONS_DB_PATH", join(defaultDataDir(), "sessions.db"));
}

function initializeDatabase(database: StorageDatabase): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA wal_autocheckpoint = 1000");
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Non-fatal; a concurrent writer may hold the WAL briefly.
  }
}

function defaultDatabase(): StorageDatabase {
  if (fallbackDatabase) return fallbackDatabase;
  const path = defaultSessionsDatabasePath();
  mkdirSync(dirname(path), { recursive: true });
  fallbackDatabase = new Database(path, { create: true });
  initializeDatabase(fallbackDatabase);
  return fallbackDatabase;
}

export function resolveStorageDatabase(): StorageDatabase {
  return configuredHost.database ?? defaultDatabase();
}

export function resolveStorageDataDir(): string {
  return configuredHost.dataDir ?? defaultDataDir();
}

export function resolveStorageLogDir(): string {
  return configuredHost.logDir ?? defaultLogDir();
}

export function resolveStorageSessionAsksDir(): string {
  return configuredHost.sessionAsksDir ?? defaultSessionAsksDir();
}

export function resolveStorageWorkspaceDir(): string {
  return configuredHost.workspaceDir ?? defaultWorkspaceDir();
}

export function resolveStorageSharedWikiDir(): string {
  return join(resolveStorageWorkspaceDir(), "wiki");
}

export function resolveStorageUsersLogDir(): string {
  return join(resolveStorageDataDir(), "users");
}

/**
 * Configure the process-local storage boundary for an embedding host.
 *
 * Resolution is lazy: importing `negotium/storage` never opens a database or
 * touches a filesystem path. The returned disposer restores the exact prior
 * host, which keeps tests and nested embeddings isolated.
 */
export function configureStorageHost(options: StorageHostOptions): () => void {
  const previous = configuredHost;
  configuredHost = Object.freeze({ ...previous, ...options });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    configuredHost = previous;
  };
}

/** Close only Negotium's fallback connection. Injected connections are borrowed. */
export function closeStorageDatabase(): void {
  if (configuredHost.database || !fallbackDatabase) return;
  fallbackDatabase.close();
  fallbackDatabase = null;
}

export function registerStorageSchemaInitializer(
  initialize: StorageSchemaInitializer,
  priority = 100,
): void {
  schemaInitializers.push({ initialize, priority });
  schemaInitializers.sort((a, b) => a.priority - b.priority);
}

export function ensureStorageSchemas(database = resolveStorageDatabase()): void {
  if (initializingDatabases.has(database)) return;
  let initialized = initializedSchemas.get(database);
  if (!initialized) {
    initialized = new Set();
    initializedSchemas.set(database, initialized);
  }
  initializingDatabases.add(database);
  try {
    for (const entry of schemaInitializers) {
      if (initialized.has(entry.initialize)) continue;
      // Mark first so a migration that calls through the public db proxy does
      // not recursively invoke itself. Remove on failure so the next call can retry.
      initialized.add(entry.initialize);
      try {
        entry.initialize(database);
      } catch (error) {
        initialized.delete(entry.initialize);
        throw error;
      }
    }
  } finally {
    initializingDatabases.delete(database);
  }
}

/** Stable proxy identity used by legacy imports and embedding hosts. */
export const storageDatabase = new Proxy({} as StorageDatabase, {
  get(_target, property) {
    const database = resolveStorageDatabase();
    ensureStorageSchemas(database);
    const value = Reflect.get(database as object, property, database);
    return typeof value === "function" ? value.bind(database) : value;
  },
  set(_target, property, value) {
    const database = resolveStorageDatabase();
    ensureStorageSchemas(database);
    return Reflect.set(database as object, property, value, database);
  },
});
