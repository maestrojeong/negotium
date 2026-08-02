import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sanitizeTopicName } from "#security/sanitize";
import { Database } from "#storage/sqlite";
import { decryptVaultValue, encryptVaultValue } from "#storage/vault-crypto";

export const CANONICAL_LOCAL_USER_ID = "local";
export const SINGLE_USER_MIGRATION_ID = "negotium-0.2.0-single-user";

export interface SingleUserMigrationOptions {
  stateDir?: string;
  sourcePrincipal?: string;
  deleteOtherUsers: boolean;
  confirmed: boolean;
}

export interface SingleUserMigrationResult {
  status: "completed" | "already-completed";
  markerPath: string;
  sourcePrincipal: string;
  movedPaths: number;
  deletedPaths: number;
  migratedTables: string[];
}

interface MoveOperation {
  source: string;
  staged: string;
  destination?: string;
  state: "pending" | "staged" | "placed";
}

interface MigrationJournal {
  id: string;
  sourcePrincipal: string;
  createdAt: string;
  phase: "filesystem" | "database" | "complete";
  operations: MoveOperation[];
}

function entries(path: string): string[] {
  return existsSync(path) && statSync(path).isDirectory() ? readdirSync(path) : [];
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertNoActiveNode(stateDir: string): void {
  for (const runtimeName of ["run", "runtime"]) {
    const infoPath = join(stateDir, runtimeName, "node-daemon.json");
    if (!existsSync(infoPath)) continue;
    try {
      const value = JSON.parse(readFileSync(infoPath, "utf8")) as { pid?: number };
      if (typeof value.pid === "number" && processIsAlive(value.pid)) {
        throw new Error(`Refusing migration while Negotium pid ${value.pid} is active.`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Refusing migration: unreadable process metadata at ${infoPath}.`);
      }
      throw error;
    }
  }
  const dbPath = join(stateDir, "data", "sessions.db");
  if (!existsSync(dbPath)) return;
  const database = new Database(dbPath, { readonly: true });
  try {
    const hasLeases = database
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_process_leases'")
      .get();
    if (!hasLeases) return;
    const leases = database
      .query<{ role: string; pid: number }, []>("SELECT role, pid FROM runtime_process_leases")
      .all();
    const active = leases.find((lease) => processIsAlive(lease.pid));
    if (active)
      throw new Error(`Refusing migration while ${active.role} pid ${active.pid} is active.`);
  } finally {
    database.close();
  }
}

function oldOwnerDirectory(ownerId: string): string {
  const digest = createHash("sha256").update(ownerId).digest("hex").slice(0, 16);
  return `${sanitizeTopicName(ownerId).slice(0, 24)}_${digest}`;
}

function addDirectoryContents(
  operations: MoveOperation[],
  sourceDir: string,
  destinationDir: string | undefined,
  stagingDir: string,
): void {
  for (const name of entries(sourceDir)) {
    operations.push({
      source: join(sourceDir, name),
      staged: join(stagingDir, randomUUID()),
      ...(destinationDir ? { destination: join(destinationDir, name) } : {}),
      state: "pending",
    });
  }
}

function assertNoCollisions(operations: MoveOperation[]): void {
  const destinations = new Set<string>();
  for (const operation of operations) {
    if (!operation.destination) continue;
    if (existsSync(operation.destination)) {
      throw new Error(`Migration collision at ${operation.destination}.`);
    }
    if (destinations.has(operation.destination)) {
      throw new Error(`Multiple legacy paths target ${operation.destination}.`);
    }
    destinations.add(operation.destination);
  }
}

function writeJournal(path: string, journal: MigrationJournal): void {
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
}

function rollbackFilesystem(journal: MigrationJournal, journalPath: string): void {
  for (const operation of [...journal.operations].reverse()) {
    const current = operation.state === "placed" ? operation.destination : operation.staged;
    if (!current || !existsSync(current) || existsSync(operation.source)) continue;
    mkdirSync(dirname(operation.source), { recursive: true });
    renameSync(current, operation.source);
    operation.state = "pending";
  }
  journal.phase = "filesystem";
  writeJournal(journalPath, journal);
}

function tablesWithColumn(database: InstanceType<typeof Database>, columnName: string): string[] {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return tables
    .map((row) => row.name)
    .filter((table) =>
      database
        .query<{ name: string }, []>(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
        .all()
        .some((column) => column.name === columnName),
    );
}

function selectedTopicIds(dbPath: string, source: string): Set<string> | null {
  if (!existsSync(dbPath)) return null;
  const database = new Database(dbPath, { readonly: true });
  try {
    const hasMemberships = database
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='topic_members'")
      .get();
    if (!hasMemberships) return null;
    return new Set(
      database
        .query<{ topic_id: string }, string>("SELECT topic_id FROM topic_members WHERE user_id = ?")
        .all(source)
        .map((row) => row.topic_id),
    );
  } finally {
    database.close();
  }
}

function migrateDatabase(
  dbPath: string,
  source: string,
  masterKey?: string,
  legacyTopicProfiles: Array<{ topicId: string; profile: string }> = [],
): string[] {
  if (!existsSync(dbPath)) return [];
  const database = new Database(dbPath);
  const userTables = tablesWithColumn(database, "user_id");
  const ownerUserTables = tablesWithColumn(database, "owner_user_id");
  const migratedTables = [...new Set([...userTables, ...ownerUserTables])];
  const retainedTopicIds = selectedTopicIds(dbPath, source);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    if (source !== CANONICAL_LOCAL_USER_ID) {
      for (const [column, tables] of [
        ["user_id", userTables],
        ["owner_user_id", ownerUserTables],
      ] as const) {
        for (const table of tables) {
          const collision = database
            .query<{ count: number }, string>(
              `SELECT COUNT(*) AS count FROM ${quote(table)} WHERE ${column} = ?`,
            )
            .get(CANONICAL_LOCAL_USER_ID)?.count;
          if (collision)
            throw new Error(`Database collision: ${table}.${column} already contains local rows.`);
        }
      }
      const hasUsers = database
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'")
        .get();
      if (hasUsers) {
        const localUser = database
          .query("SELECT 1 FROM users WHERE id = ?")
          .get(CANONICAL_LOCAL_USER_ID);
        if (localUser)
          throw new Error("Database collision: users already contains canonical local.");
      }
    }
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("BEGIN IMMEDIATE");
    for (const table of userTables) {
      database.query(`DELETE FROM ${quote(table)} WHERE user_id <> ?`).run(source);
      if (table === "vault" && source !== CANONICAL_LOCAL_USER_ID) {
        if (!masterKey)
          throw new Error("Cannot migrate encrypted vault rows without vault-master-key.");
        const rows = database
          .query<{ key: string; value: string }, string>(
            "SELECT key, value FROM vault WHERE user_id = ?",
          )
          .all(source);
        for (const row of rows) {
          const plaintext = decryptVaultValue(source, row.key, row.value, masterKey).value;
          database
            .query("UPDATE vault SET value = ? WHERE user_id = ? AND key = ?")
            .run(
              encryptVaultValue(CANONICAL_LOCAL_USER_ID, row.key, plaintext, masterKey),
              source,
              row.key,
            );
        }
      }
      database
        .query(`UPDATE ${quote(table)} SET user_id = ? WHERE user_id = ?`)
        .run(CANONICAL_LOCAL_USER_ID, source);
    }
    for (const table of ownerUserTables) {
      database.query(`DELETE FROM ${quote(table)} WHERE owner_user_id <> ?`).run(source);
      database
        .query(`UPDATE ${quote(table)} SET owner_user_id = ? WHERE owner_user_id = ?`)
        .run(CANONICAL_LOCAL_USER_ID, source);
    }
    if (retainedTopicIds) {
      database.exec("CREATE TEMP TABLE migration_selected_topics (id TEXT PRIMARY KEY)");
      for (const topicId of retainedTopicIds) {
        database.query("INSERT INTO migration_selected_topics (id) VALUES (?)").run(topicId);
      }
      const topicTables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((row) => row.name)
        .filter((table) =>
          database
            .query<{ name: string }, []>(`PRAGMA table_info(${quote(table)})`)
            .all()
            .some((column) => column.name === "topic_id"),
        );
      for (const table of topicTables) {
        database
          .query(
            `DELETE FROM ${quote(table)} WHERE topic_id NOT IN (SELECT id FROM migration_selected_topics)`,
          )
          .run();
      }
      if (
        database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_topics'").get()
      ) {
        database
          .query(
            "DELETE FROM api_topics WHERE id NOT IN (SELECT id FROM migration_selected_topics)",
          )
          .run();
      }
    }
    // browser owner_id is end-user identity; runtime lease/query owner_id columns are not.
    if (
      database
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_profiles'")
        .get()
    ) {
      database.query("DELETE FROM browser_profiles WHERE owner_id <> ?").run(source);
      database
        .query("UPDATE browser_profiles SET owner_id = ? WHERE owner_id = ?")
        .run(CANONICAL_LOCAL_USER_ID, source);
    }
    if (
      database
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_topics'")
        .get() &&
      database
        .query<{ name: string }, []>("PRAGMA table_info(api_topics)")
        .all()
        .some((column) => column.name === "browser_profile_owner")
    ) {
      database
        .query("UPDATE api_topics SET browser_profile_owner = ? WHERE browser_profile_owner = ?")
        .run(CANONICAL_LOCAL_USER_ID, source);
      if (retainedTopicIds) {
        database
          .query(
            "UPDATE api_topics SET browser_profile_owner = ? WHERE browser_profile_owner IS NOT NULL",
          )
          .run(CANONICAL_LOCAL_USER_ID);
      } else {
        database
          .query(
            "DELETE FROM api_topics WHERE browser_profile_owner IS NOT NULL AND browser_profile_owner <> ?",
          )
          .run(CANONICAL_LOCAL_USER_ID);
      }
      for (const binding of legacyTopicProfiles) {
        database
          .query(
            "UPDATE api_topics SET browser_profile = ?, browser_profile_owner = ? WHERE id = ?",
          )
          .run(binding.profile, CANONICAL_LOCAL_USER_ID, binding.topicId);
      }
    }
    if (database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()) {
      database.query("DELETE FROM users WHERE id <> ?").run(source);
      database.query("UPDATE users SET id = ? WHERE id = ?").run(CANONICAL_LOCAL_USER_ID, source);
    }
    database.exec("COMMIT");
    database.exec("PRAGMA foreign_keys = ON");
    const fkErrors = database.query("PRAGMA foreign_key_check").all();
    if (fkErrors.length > 0) throw new Error("Database migration left foreign-key violations.");
    return migratedTables;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}

export function migrateSingleUserState(
  options: SingleUserMigrationOptions,
): SingleUserMigrationResult {
  const stateDir = resolve(
    options.stateDir ?? process.env.NEGOTIUM_STATE_DIR ?? join(homedir(), ".negotium"),
  );
  const source = options.sourcePrincipal?.trim() || CANONICAL_LOCAL_USER_ID;
  if (!source || /[/\\]|\.\./.test(source)) throw new Error("Invalid source principal.");
  if (!options.deleteOtherUsers || !options.confirmed) {
    throw new Error(
      "Migration requires --delete-other-users and --yes; other principals are permanently deleted.",
    );
  }
  const markerPath = join(stateDir, ".migration-0.2.0-single-user.json");
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      id?: string;
      sourcePrincipal?: string;
      movedPaths?: number;
      deletedPaths?: number;
      migratedTables?: string[];
    };
    if (marker.id !== SINGLE_USER_MIGRATION_ID)
      throw new Error(`Unexpected migration marker at ${markerPath}.`);
    return {
      status: "already-completed",
      markerPath,
      sourcePrincipal: marker.sourcePrincipal ?? source,
      movedPaths: marker.movedPaths ?? 0,
      deletedPaths: marker.deletedPaths ?? 0,
      migratedTables: marker.migratedTables ?? [],
    };
  }
  assertNoActiveNode(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const stagingRoot = join(stateDir, ".migration-0.2.0-staging");
  const journalPath = join(stagingRoot, "journal.json");
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  let journal: MigrationJournal;
  if (existsSync(journalPath)) {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as MigrationJournal;
    if (journal.sourcePrincipal !== source)
      throw new Error("Interrupted migration used a different source principal.");
  } else {
    const operations: MoveOperation[] = [];
    const retainedTopicIds = selectedTopicIds(join(stateDir, "data", "sessions.db"), source);
    addDirectoryContents(operations, join(stateDir, "run"), join(stateDir, "runtime"), stagingRoot);
    addDirectoryContents(
      operations,
      join(stateDir, "bin"),
      join(stateDir, "binaries"),
      stagingRoot,
    );
    for (const secret of ["node-control-token", "runtime-mcp-secret", "vault-master-key"]) {
      const sourcePath = join(stateDir, secret);
      if (existsSync(sourcePath))
        operations.push({
          source: sourcePath,
          staged: join(stagingRoot, randomUUID()),
          destination: join(stateDir, "secrets", secret),
          state: "pending",
        });
    }
    const legacyVaultDb = join(stateDir, "data", "vault.db");
    if (existsSync(legacyVaultDb)) {
      operations.push({
        source: legacyVaultDb,
        staged: join(stagingRoot, randomUUID()),
        destination: join(stateDir, "data", "vault", "vault.db"),
        state: "pending",
      });
    }
    for (const store of ["conversations", "tasks", "users"]) {
      const root = join(stateDir, "data", store);
      addDirectoryContents(operations, join(root, source), root, stagingRoot);
      for (const owner of entries(root)) {
        const ownerPath = join(root, owner);
        if (owner !== source && statSync(ownerPath).isDirectory()) {
          operations.push({
            source: ownerPath,
            staged: join(stagingRoot, randomUUID()),
            state: "pending",
          });
        }
      }
    }
    for (const legacyWorkspaceDir of ["contexts", "dm", "sessions"]) {
      addDirectoryContents(
        operations,
        join(stateDir, "workspace", legacyWorkspaceDir),
        join(stateDir, "data", legacyWorkspaceDir),
        stagingRoot,
      );
    }
    for (const topicId of entries(join(stateDir, "workspace", "topics"))) {
      const topicPath = join(stateDir, "workspace", "topics", topicId);
      if (retainedTopicIds && !retainedTopicIds.has(topicId)) {
        operations.push({
          source: topicPath,
          staged: join(stagingRoot, randomUUID()),
          state: "pending",
        });
      } else {
        addDirectoryContents(
          operations,
          join(topicPath, "uploads"),
          join(stateDir, "data", "uploads", topicId),
          stagingRoot,
        );
      }
    }
    if (retainedTopicIds) {
      for (const topicId of entries(join(stateDir, "workspace", "wiki"))) {
        if (retainedTopicIds.has(topicId)) continue;
        operations.push({
          source: join(stateDir, "workspace", "wiki", topicId),
          staged: join(stagingRoot, randomUUID()),
          state: "pending",
        });
      }
    }
    const legacyBrowserRoot = join(stateDir, "workspace", "browser-profiles");
    const selectedProfiles = join(legacyBrowserRoot, "profiles", oldOwnerDirectory(source));
    addDirectoryContents(
      operations,
      selectedProfiles,
      join(stateDir, "browser", "profiles"),
      stagingRoot,
    );
    for (const owner of entries(join(legacyBrowserRoot, "profiles"))) {
      const ownerPath = join(legacyBrowserRoot, "profiles", owner);
      if (ownerPath !== selectedProfiles) {
        operations.push({
          source: ownerPath,
          staged: join(stagingRoot, randomUUID()),
          state: "pending",
        });
      }
    }
    for (const topicId of entries(legacyBrowserRoot).filter((name) => name !== "profiles")) {
      if (retainedTopicIds && !retainedTopicIds.has(topicId)) {
        operations.push({
          source: join(legacyBrowserRoot, topicId),
          staged: join(stagingRoot, randomUUID()),
          state: "pending",
        });
        continue;
      }
      const profile = `legacy_${createHash("sha256").update(topicId).digest("hex").slice(0, 12)}`;
      operations.push({
        source: join(legacyBrowserRoot, topicId),
        staged: join(stagingRoot, randomUUID()),
        destination: join(stateDir, "browser", "profiles", profile),
        state: "pending",
      });
    }
    assertNoCollisions(operations);
    journal = {
      id: SINGLE_USER_MIGRATION_ID,
      sourcePrincipal: source,
      createdAt: new Date().toISOString(),
      phase: "filesystem",
      operations,
    };
    writeJournal(journalPath, journal);
  }
  const dbPath = join(stateDir, "data", "sessions.db");
  const dbBackup = join(stagingRoot, "sessions.db.rollback");
  const vaultDbPath = join(stateDir, "data", "vault", "vault.db");
  const vaultDbBackup = join(stagingRoot, "vault.db.rollback");
  try {
    for (const operation of journal.operations) {
      // Reconcile a crash between rename(2) and the following journal write.
      if (
        operation.state === "pending" &&
        !existsSync(operation.source) &&
        existsSync(operation.staged)
      ) {
        operation.state = "staged";
      }
      if (
        operation.state === "staged" &&
        operation.destination &&
        !existsSync(operation.staged) &&
        existsSync(operation.destination)
      ) {
        operation.state = "placed";
      }
      if (operation.state === "pending") {
        mkdirSync(dirname(operation.staged), { recursive: true });
        renameSync(operation.source, operation.staged);
        operation.state = "staged";
        writeJournal(journalPath, journal);
      }
      if (operation.state === "staged" && operation.destination) {
        mkdirSync(dirname(operation.destination), { recursive: true });
        renameSync(operation.staged, operation.destination);
        operation.state = "placed";
        writeJournal(journalPath, journal);
      }
    }
    journal.phase = "database";
    writeJournal(journalPath, journal);
    if (existsSync(dbPath) && !existsSync(dbBackup)) copyFileSync(dbPath, dbBackup);
    if (existsSync(vaultDbPath) && !existsSync(vaultDbBackup))
      copyFileSync(vaultDbPath, vaultDbBackup);
    const masterKeyPath = join(stateDir, "secrets", "vault-master-key");
    const masterKey = existsSync(masterKeyPath)
      ? readFileSync(masterKeyPath, "utf8").trim()
      : undefined;
    const legacyBrowserRoot = join(stateDir, "workspace", "browser-profiles");
    const legacyTopicProfiles = journal.operations
      .filter(
        (operation) => dirname(operation.source) === legacyBrowserRoot && operation.destination,
      )
      .map((operation) => ({
        topicId: basename(operation.source),
        profile: basename(operation.destination!),
      }));
    const migratedTables = migrateDatabase(dbPath, source, masterKey, legacyTopicProfiles);
    const migratedVaultTables = migrateDatabase(vaultDbPath, source, masterKey);
    for (const table of migratedVaultTables)
      if (!migratedTables.includes(table)) migratedTables.push(table);
    mkdirSync(join(stateDir, "secrets"), { recursive: true, mode: 0o700 });
    chmodSync(join(stateDir, "secrets"), 0o700);
    for (const secret of ["node-control-token", "runtime-mcp-secret", "vault-master-key"]) {
      const path = join(stateDir, "secrets", secret);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    const deletedPaths = journal.operations.filter((operation) => !operation.destination).length;
    const movedPaths = journal.operations.length - deletedPaths;
    const marker = {
      id: SINGLE_USER_MIGRATION_ID,
      version: "0.2.0",
      completedAt: new Date().toISOString(),
      sourcePrincipal: source,
      canonicalPrincipal: CANONICAL_LOCAL_USER_ID,
      movedPaths,
      deletedPaths,
      migratedTables,
    };
    for (const store of ["conversations", "tasks", "users"]) {
      rmSync(join(stateDir, "data", store, source), { recursive: true, force: true });
    }
    rmSync(join(stateDir, "workspace", "browser-profiles"), { recursive: true, force: true });
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    journal.phase = "complete";
    rmSync(stagingRoot, { recursive: true, force: true });
    return {
      status: "completed",
      markerPath,
      sourcePrincipal: source,
      movedPaths,
      deletedPaths,
      migratedTables,
    };
  } catch (error) {
    if (existsSync(dbBackup)) copyFileSync(dbBackup, dbPath);
    if (existsSync(vaultDbBackup)) copyFileSync(vaultDbBackup, vaultDbPath);
    rollbackFilesystem(journal, journalPath);
    throw error;
  }
}
