import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "#storage/sqlite";
import type { StorageDatabase, StorageHostConfig } from "#storage/storage-contract";

export type {
  StorageDatabase,
  StorageDatabaseAdapter,
  StorageDatabaseInput,
  StorageHostConfig,
  StorageHostOptions,
  StorageStatement,
  StorageTransaction,
} from "#storage/storage-contract";

let configuredHost: Readonly<StorageHostConfig> = {};
type InternalStorageDatabase = InstanceType<typeof Database>;
type OwnedStorageDatabase = InternalStorageDatabase & { close(): void };
let fallbackDatabase: OwnedStorageDatabase | null = null;
let fallbackDatabasePath: string | null = null;

interface StorageHostFrame {
  active: boolean;
  patch: Readonly<StorageHostConfig>;
}

const storageHostFrames: StorageHostFrame[] = [];

type StorageSchemaInitializer = (database: InternalStorageDatabase) => void;
interface RegisteredSchemaInitializer {
  initialize: StorageSchemaInitializer;
  priority: number;
}

const schemaInitializers: RegisteredSchemaInitializer[] = [];
const initializedSchemas = new WeakMap<InternalStorageDatabase, Set<StorageSchemaInitializer>>();
const initializingDatabases = new WeakSet<InternalStorageDatabase>();

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
  return envPath("SESSIONS_DB_PATH", join(resolveStorageDataDir(), "sessions.db"));
}

function initializeDatabase(database: InternalStorageDatabase): void {
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

function defaultDatabase(): InternalStorageDatabase {
  const path = defaultSessionsDatabasePath();
  if (fallbackDatabase && fallbackDatabasePath === path) return fallbackDatabase;
  if (fallbackDatabase) fallbackDatabase.close();
  mkdirSync(dirname(path), { recursive: true });
  fallbackDatabase = new Database(path, { create: true }) as unknown as OwnedStorageDatabase;
  fallbackDatabasePath = path;
  initializeDatabase(fallbackDatabase);
  return fallbackDatabase;
}

export function resolveStorageDatabase(): InternalStorageDatabase {
  return (configuredHost.database ?? defaultDatabase()) as InternalStorageDatabase;
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
  return configuredHost.sharedWikiDir ?? join(resolveStorageWorkspaceDir(), "wiki");
}

export function resolveStorageUsersLogDir(): string {
  return configuredHost.usersLogDir ?? join(resolveStorageDataDir(), "users");
}

const STORAGE_PATH_KEYS = [
  "dataDir",
  "logDir",
  "sessionAsksDir",
  "workspaceDir",
  "sharedWikiDir",
  "usersLogDir",
] as const;

function normalizeStorageHostPatch(options: StorageHostConfig): Readonly<StorageHostConfig> {
  const patch: StorageHostConfig = {};
  if (options.database !== undefined) patch.database = options.database;
  for (const key of STORAGE_PATH_KEYS) {
    const value = options[key];
    if (value === undefined) continue;
    if (!value.trim()) throw new TypeError(`${key} must not be empty`);
    patch[key] = resolve(value);
  }
  return Object.freeze(patch);
}

function refreshConfiguredHost(): void {
  configuredHost = Object.freeze(
    Object.assign(
      {},
      ...storageHostFrames.filter((frame) => frame.active).map((frame) => frame.patch),
    ),
  );
}

/**
 * Configure the process-local storage boundary for an embedding host.
 *
 * Resolution is lazy: importing `negotium/storage` never opens a database or
 * touches a filesystem path. The returned disposer restores the exact prior
 * host, which keeps tests and nested embeddings isolated.
 */
export function configureStorageHost(options: StorageHostConfig): () => void {
  const frame: StorageHostFrame = { active: true, patch: normalizeStorageHostPatch(options) };
  storageHostFrames.push(frame);
  refreshConfiguredHost();
  return () => {
    if (!frame.active) return;
    frame.active = false;
    const index = storageHostFrames.indexOf(frame);
    if (index >= 0) storageHostFrames.splice(index, 1);
    refreshConfiguredHost();
  };
}

/** Remove every configured host layer and restore standalone fallbacks. */
export function resetStorageHost(): void {
  for (const frame of storageHostFrames) frame.active = false;
  storageHostFrames.length = 0;
  refreshConfiguredHost();
}

/** Close only Negotium's fallback connection. Injected connections are borrowed. */
export function closeStorageDatabase(): void {
  if (!fallbackDatabase) return;
  fallbackDatabase.close();
  fallbackDatabase = null;
  fallbackDatabasePath = null;
}

export function registerStorageSchemaInitializer(
  initialize: StorageSchemaInitializer,
  priority = 100,
): void {
  schemaInitializers.push({ initialize, priority });
  schemaInitializers.sort((a, b) => a.priority - b.priority);
}

export function ensureStorageSchemas(
  database: InternalStorageDatabase = resolveStorageDatabase(),
): void {
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
export const internalStorageDatabase = new Proxy({} as InternalStorageDatabase, {
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

/** Structurally typed view intended for embedding hosts. */
export const storageDatabase = internalStorageDatabase as unknown as StorageDatabase;
