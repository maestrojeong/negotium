import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SESSIONS_DB } from "#platform/config";
import { Database } from "#storage/sqlite";

mkdirSync(dirname(SESSIONS_DB), { recursive: true });

export const db = new Database(SESSIONS_DB, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
// Auto-checkpoint every ~1000 WAL pages (~4 MB at 4KB page size) to keep the
// WAL file from growing unbounded during long-running pm2 sessions. The
// default is 1000 but we set it explicitly so the policy is auditable.
db.exec("PRAGMA wal_autocheckpoint = 1000");
// Also run a TRUNCATE checkpoint on startup to reclaim any WAL space
// accumulated while the bot was stopped (checkpointer doesn't run when
// no connections are open).
try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} catch {
  // Non-fatal; a concurrent writer may hold the WAL briefly.
}
