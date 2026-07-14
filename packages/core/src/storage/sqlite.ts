// Runtime-adaptive SQLite façade.
//
// Why this exists: Otium normally runs on bun and uses `bun:sqlite` (native,
// fast, zero-build). But the `codex` agent's MCP servers must run on pure node
// — codex 0.135's rmcp stdio client can't handshake with bun-spawned servers
// (see serverLaunch in platform/mcp-config.ts). `bun:sqlite` doesn't exist
// under node, so any MCP server that touches the DB would crash on import.
//
// This module picks the backend at runtime and re-exports it as `Database`:
//   - under bun  → the real `bun:sqlite` Database (unchanged behavior)
//   - under node → a thin shim over node:sqlite's DatabaseSync exposing the
//     exact subset Otium uses: new Database(path, {readonly?,create?}),
//     .query()/.prepare() → statement, .exec(), .run(), .transaction(fn),
//     .close(); statements support positional `?` params via .run()/.get()/
//     .all(). (No named-object params / .values()/.iterate()/.as() are used in
//     this codebase, so the shim intentionally omits them.)
//
// The TYPE of the exported `Database` is bun:sqlite's own class type (imported
// type-only, so it's erased at runtime and never resolved under node). That
// keeps every existing call site — including generic `.query<Row, Params>()`
// usages — type-checking exactly as before with zero changes.
//
// The bun branch uses a dynamic import so node never resolves the `bun:sqlite`
// specifier (dead code under node), and the node branch's `node:sqlite` import
// never runs under bun.

import type { Database as BunDatabase } from "bun:sqlite";

// `mock.module()` can replace the Bun global while a test graph is being
// evaluated. The runtime version flag is stable and is also the documented
// cross-runtime discriminator.
const isBun = typeof process.versions.bun === "string";

type DatabaseCtor = typeof BunDatabase;

let Database: DatabaseCtor;

if (isBun) {
  ({ Database } = await import("bun:sqlite"));
} else {
  // node:sqlite has no type declarations under our tsconfig (`types: bun-types`
  // only), and `bun-types` doesn't ship them — so type the dynamic import
  // locally and use a `string` specifier to keep tsc from trying to resolve it.
  type NodeStatement = {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  type NodeDatabaseSync = {
    prepare(sql: string): NodeStatement;
    exec(sql: string): void;
    close(): void;
  };
  type NodeSqliteModule = {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
  };
  // Keep Bun's resolver from eagerly resolving the Node-only builtin even
  // though this branch is dead there (notably under `bun test` + mock.module).
  const nodeSqliteSpecifier = ["node", "sqlite"].join(":");
  const { DatabaseSync } = (await import(nodeSqliteSpecifier)) as NodeSqliteModule;

  type DbOptions = { readonly?: boolean; create?: boolean };

  class NodeDatabase {
    #db: NodeDatabaseSync;

    constructor(path: string, options: DbOptions = {}) {
      // node:sqlite opens read-write and creates-if-missing by default, which
      // matches bun's `{create:true}`. For readonly we must not create.
      this.#db = options.readonly
        ? new DatabaseSync(path, { readOnly: true })
        : new DatabaseSync(path);
    }

    query(sql: string) {
      return this.#db.prepare(sql);
    }

    prepare(sql: string) {
      return this.#db.prepare(sql);
    }

    exec(sql: string): void {
      this.#db.exec(sql);
    }

    run(sql: string, ...params: unknown[]) {
      return this.#db.prepare(sql).run(...params);
    }

    transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
      // bun's db.transaction(fn) returns a function that runs fn inside a
      // transaction when called. node:sqlite has no helper, so emulate with
      // BEGIN/COMMIT/ROLLBACK. It also exposes deferred/immediate/exclusive
      // variants; mirror those so Node-launched MCP servers can share call
      // sites with Bun.
      const run =
        (begin: "BEGIN" | "BEGIN DEFERRED" | "BEGIN IMMEDIATE" | "BEGIN EXCLUSIVE") =>
        (...args: Args): R => {
          this.#db.exec(begin);
          try {
            const result = fn(...args);
            this.#db.exec("COMMIT");
            return result;
          } catch (err) {
            this.#db.exec("ROLLBACK");
            throw err;
          }
        };
      const tx = run("BEGIN") as ((...args: Args) => R) & {
        deferred: (...args: Args) => R;
        immediate: (...args: Args) => R;
        exclusive: (...args: Args) => R;
      };
      tx.deferred = run("BEGIN DEFERRED");
      tx.immediate = run("BEGIN IMMEDIATE");
      tx.exclusive = run("BEGIN EXCLUSIVE");
      return tx;
    }

    close(): void {
      this.#db.close();
    }
  }

  Database = NodeDatabase as unknown as DatabaseCtor;
}

export { Database };
