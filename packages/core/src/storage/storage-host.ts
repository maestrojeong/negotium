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

type InternalStorageDatabase = InstanceType<typeof Database>;
type OwnedStorageDatabase = InternalStorageDatabase & { close(): void };

interface StorageHostFrame {
  active: boolean;
  patch: Readonly<StorageHostConfig>;
}

type StorageSchemaInitializer = (database: InternalStorageDatabase) => void;
interface RegisteredSchemaInitializer {
  initialize: StorageSchemaInitializer;
  priority: number;
}

interface StorageHostState {
  configuredHost: Readonly<StorageHostConfig>;
  fallbackDatabase: OwnedStorageDatabase | null;
  fallbackDatabasePath: string | null;
  frames: StorageHostFrame[];
  schemaInitializers: RegisteredSchemaInitializer[];
  initializedSchemas: WeakMap<InternalStorageDatabase, Set<StorageSchemaInitializer>>;
  initializingDatabases: WeakSet<InternalStorageDatabase>;
}

/**
 * Which database an embedded Negotium uses is a property of the *process*, so
 * the state deciding it is keyed off a registered symbol rather than held in
 * module scope.
 *
 * Module scope would be equivalent only if every caller resolved to the same
 * module instance, and in the published package they do not:
 * `build-negotium-package.ts` emits most public entrypoints as independent
 * graphs, so each gets a private copy of this file. A host that configured
 * `negotium/storage` therefore left `negotium/agent-helpers` unconfigured, and
 * that copy opened a second database under the default state directory — with
 * no error, since both files are valid and writable.
 *
 * Merging those entrypoints into one graph looks tidier and does cut ~3MB from
 * `dist`, but Bun 1.2.15 (the pinned version) emits a shared chunk's export
 * list twice and the result is invalid ESM — "Cannot export a duplicate name".
 * That is bundler output with no counterpart in this source, so there is
 * nothing to de-duplicate here; it is fixed in Bun 1.3.14. Until the floor
 * moves, correctness cannot depend on how the package is chunked.
 */
const STORAGE_HOST_STATE = Symbol.for("negotium.storage-host.state.v1");

function storageState(): StorageHostState {
  const holder = globalThis as typeof globalThis & { [STORAGE_HOST_STATE]?: StorageHostState };
  const existing = holder[STORAGE_HOST_STATE];
  if (existing) return existing;
  const created: StorageHostState = {
    configuredHost: {},
    fallbackDatabase: null,
    fallbackDatabasePath: null,
    frames: [],
    schemaInitializers: [],
    initializedSchemas: new WeakMap(),
    initializingDatabases: new WeakSet(),
  };
  Object.defineProperty(holder, STORAGE_HOST_STATE, {
    value: created,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return created;
}

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
  const runDir = envPath("NEGOTIUM_RUN_DIR", join(defaultStateDir(), "runtime"));
  return join(runDir, "session-asks");
}

function defaultSessionsDatabasePath(): string {
  return envPath("SESSIONS_DB_PATH", join(resolveStorageDataDir(), "sessions.db"));
}

const SQLITE_INIT_RETRY_MS = 25;
const SQLITE_INIT_TIMEOUT_MS = 5_000;
const SQLITE_INIT_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/i.test(message);
}

function execWithBusyRetry(
  database: InternalStorageDatabase,
  sql: string,
  timeoutMs = SQLITE_INIT_TIMEOUT_MS,
): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      database.exec(sql);
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(SQLITE_INIT_SLEEP, 0, 0, Math.min(SQLITE_INIT_RETRY_MS, deadline - Date.now()));
    }
  }
}

export function initializeDatabase(database: InternalStorageDatabase): void {
  // busy_timeout FIRST. Switching to WAL needs a brief exclusive lock, so when
  // two processes open the same database at the same moment — the node daemon
  // and an adapter, or two MCP servers — one of them hits SQLITE_BUSY. With the
  // timeout configured afterwards there was no retry budget in effect for the
  // statement that needed it most. Older Bun releases can still surface
  // SQLITE_BUSY immediately for journal_mode, so keep a bounded host-level
  // retry around that one exclusive transition as well.
  database.exec("PRAGMA busy_timeout = 5000");
  execWithBusyRetry(database, "PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA wal_autocheckpoint = 1000");
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Non-fatal; a concurrent writer may hold the WAL briefly.
  }
}

function defaultDatabase(): InternalStorageDatabase {
  const path = defaultSessionsDatabasePath();
  const state = storageState();
  if (state.fallbackDatabase && state.fallbackDatabasePath === path) return state.fallbackDatabase;
  if (state.fallbackDatabase) state.fallbackDatabase.close();
  mkdirSync(dirname(path), { recursive: true });
  state.fallbackDatabase = new Database(path, { create: true }) as unknown as OwnedStorageDatabase;
  state.fallbackDatabasePath = path;
  initializeDatabase(state.fallbackDatabase);
  return state.fallbackDatabase;
}

export function resolveStorageDatabase(): InternalStorageDatabase {
  return (storageState().configuredHost.database ?? defaultDatabase()) as InternalStorageDatabase;
}

/**
 * The host-injected connection, or null when Negotium owns its own store.
 *
 * Unlike {@link resolveStorageDatabase} this never opens anything. Callers that
 * manage their own short-lived connections need to know whether a host store
 * exists *before* deciding to open one by path: opening it anyway is how an
 * embedded Negotium ends up writing half its state into the host's database and
 * the other half into `~/.negotium`, with nothing reporting an error.
 */
export function configuredStorageDatabase(): InternalStorageDatabase | null {
  return (storageState().configuredHost.database as InternalStorageDatabase | undefined) ?? null;
}

export function resolveStorageDataDir(): string {
  return storageState().configuredHost.dataDir ?? defaultDataDir();
}

export function resolveStorageLogDir(): string {
  return storageState().configuredHost.logDir ?? defaultLogDir();
}

export function resolveStorageSessionAsksDir(): string {
  return storageState().configuredHost.sessionAsksDir ?? defaultSessionAsksDir();
}

export function resolveStorageWorkspaceDir(): string {
  return storageState().configuredHost.workspaceDir ?? defaultWorkspaceDir();
}

export function resolveStorageSharedWikiDir(): string {
  return storageState().configuredHost.sharedWikiDir ?? join(resolveStorageWorkspaceDir(), "wiki");
}

export function resolveStorageUsersLogDir(): string {
  return storageState().configuredHost.usersLogDir ?? join(resolveStorageDataDir(), "users");
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
  if (options.database !== undefined) {
    options.database.exec("PRAGMA foreign_keys = ON");
    patch.database = options.database;
  }
  for (const key of STORAGE_PATH_KEYS) {
    const value = options[key];
    if (value === undefined) continue;
    if (!value.trim()) throw new TypeError(`${key} must not be empty`);
    patch[key] = resolve(value);
  }
  return Object.freeze(patch);
}

function refreshConfiguredHost(): void {
  const state = storageState();
  state.configuredHost = Object.freeze(
    Object.assign({}, ...state.frames.filter((frame) => frame.active).map((frame) => frame.patch)),
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
  storageState().frames.push(frame);
  refreshConfiguredHost();
  return () => {
    if (!frame.active) return;
    frame.active = false;
    const frames = storageState().frames;
    const index = frames.indexOf(frame);
    if (index >= 0) frames.splice(index, 1);
    refreshConfiguredHost();
  };
}

/** Remove every configured host layer and restore standalone fallbacks. */
export function resetStorageHost(): void {
  const frames = storageState().frames;
  for (const frame of frames) frame.active = false;
  frames.length = 0;
  refreshConfiguredHost();
}

/** Close only Negotium's fallback connection. Injected connections are borrowed. */
export function closeStorageDatabase(): void {
  const state = storageState();
  if (!state.fallbackDatabase) return;
  state.fallbackDatabase.close();
  state.fallbackDatabase = null;
  state.fallbackDatabasePath = null;
}

export function registerStorageSchemaInitializer(
  initialize: StorageSchemaInitializer,
  priority = 100,
): void {
  const initializers = storageState().schemaInitializers;
  initializers.push({ initialize, priority });
  initializers.sort((a, b) => a.priority - b.priority);
}

export function ensureStorageSchemas(
  database: InternalStorageDatabase = resolveStorageDatabase(),
): void {
  const state = storageState();
  if (state.initializingDatabases.has(database)) return;
  let initialized = state.initializedSchemas.get(database);
  if (!initialized) {
    initialized = new Set();
    state.initializedSchemas.set(database, initialized);
  }
  state.initializingDatabases.add(database);
  try {
    for (const entry of state.schemaInitializers) {
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
    state.initializingDatabases.delete(database);
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
