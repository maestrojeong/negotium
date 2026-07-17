export interface StorageStatement<Result = unknown, _Params = unknown> {
  get(...params: any[]): Result | null | undefined;
  all(...params: any[]): Result[];
  run(...params: any[]): any;
}

export interface StorageTransaction<Args extends unknown[], Result> {
  (...args: Args): Result;
  deferred: (...args: Args) => Result;
  immediate: (...args: Args) => Result;
  exclusive: (...args: Args) => Result;
}

/** Structural SQLite surface supported by Bun and Negotium's Node shim. */
export interface StorageDatabase {
  query<Result = unknown, Params = unknown>(sql: string): StorageStatement<Result, Params>;
  prepare<Result = unknown, Params = unknown>(sql: string): StorageStatement<Result, Params>;
  exec(sql: string): void;
  run(sql: string, ...params: any[]): any;
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): StorageTransaction<Args, Result>;
}

/** Broad structural input accepted from Bun, Node, or a host-provided adapter. */
export interface StorageDatabaseAdapter {
  query(...args: any[]): any;
  prepare(...args: any[]): any;
  exec(sql: string): void;
  run(sql: string, ...params: any[]): any;
  transaction(...args: any[]): any;
}

export type StorageDatabaseInput = StorageDatabase | StorageDatabaseAdapter;

export interface StorageHostConfig {
  /** Borrowed SQLite connection. Negotium never closes an injected database. */
  database?: StorageDatabaseInput;
  /** Persistent JSON/JSONL state root. */
  dataDir?: string;
  /** Activity and token-usage log root. */
  logDir?: string;
  /** Durable ask edge root. Defaults to Negotium's runtime ask directory. */
  sessionAsksDir?: string;
  /** Shared topic workspace root used by wiki/archive helpers. */
  workspaceDir?: string;
  /** Shared wiki root. Defaults to `<workspaceDir>/wiki`. */
  sharedWikiDir?: string;
  /** Per-user sent-file log root. Defaults to `<dataDir>/users`. */
  usersLogDir?: string;
}

/** Compatibility name retained for 0.1.11 consumers. */
export type StorageHostOptions = StorageHostConfig;
