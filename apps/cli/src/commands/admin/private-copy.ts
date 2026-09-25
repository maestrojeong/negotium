/**
 * Read-only analysis never opens the live database (review finding 5).
 *
 * Opening a WAL database with SQLite — even `readonly` — may create or touch
 * its `-shm` (and a missing `-wal`), so "a report changes nothing" would be
 * false. Instead the live files are copied byte-for-byte into a fresh 0700
 * directory owned by this user (the main file plus `-wal` / `-journal` when
 * present; `-shm` is only an index and is rebuilt), and SQLite opens the COPY,
 * which replays the copied WAL there. The live files are only ever `read(2)`.
 *
 * Consistency: every source file's (dev, ino, size, mtime) is recorded before
 * and after the read; if anything moved (a writer or checkpoint ran), the copy
 * is discarded and retried, and after three attempts the command refuses. The
 * copy directory is removed on close and at process exit.
 *
 * The copying process must not itself hold the database open (through SQLite
 * or otherwise): POSIX `fcntl` locks belong to the process, so the `close(2)`
 * after our `read(2)` silently drops every SQLite lock this process holds on
 * that file. Another process's last connection then believes it is alone,
 * checkpoints and deletes `-wal`/`-shm` under the still-open connection, which
 * later fails with "disk I/O error" / "database disk image is malformed" (seen
 * on Linux + Bun 1.2.15). The CLI copies before it ever loads core; the copy
 * refuses when an fd of this process already refers to the source.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuse } from "./errors";
import { openSafeDir } from "./safe-fs";

const COPIED_SUFFIXES = ["", "-wal", "-journal"] as const;
const ALL_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const ATTEMPTS = 3;

export interface PrivateCopy {
  /** The live path that was copied. */
  source: string;
  /** Private directory (0700) holding the copy. */
  dir: string;
  path: string;
  db: Database;
  /** sha256 of the copied main-file bytes (the exact bytes analysed). */
  mainSha256: string;
  mainSize: number;
  copiedSidecars: string[];
  close(): void;
}

const openCopies = new Set<PrivateCopy>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const copy of openCopies) copy.close();
  });
}

interface FileState {
  suffix: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function stateOf(path: string, suffix: string): FileState | null {
  let stat: Stats;
  try {
    stat = statSync(path + suffix);
  } catch {
    return null;
  }
  return { suffix, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameStates(a: (FileState | null)[], b: (FileState | null)[]): boolean {
  return a.every((left, index) => {
    const right = b[index] ?? null;
    if (left === null || right === null) return left === right;
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs
    );
  });
}

function writeNewFile(path: string, bytes: Uint8Array): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    closeSync(fd);
  }
}

export interface PrivateCopyOptions {
  /** Refuse when any `-wal`/`-shm`/`-journal` exists (audit snapshots are single files). */
  requireNoSidecars?: boolean;
  /** Test seam: runs between reading the sources and the "after" stat. */
  afterReadForTests?: () => void;
  /**
   * Test seam: in-process tests seed the DB through core first, on a DB no
   * other process opens, so the lock drop is harmless there. Never from argv.
   */
  allowSourceOpenInThisProcessForTests?: boolean;
}

/**
 * Whether an fd of this process refers to `target` (same dev/ino). Effective
 * on Linux, where `/dev/fd` is `/proc/self/fd` and lists every fd; best-effort
 * elsewhere (macOS lists only a few fds there), where it may miss one.
 */
export function isOpenInThisProcess(target: Stats): boolean {
  let fds: string[];
  try {
    fds = readdirSync("/dev/fd");
  } catch {
    return false;
  }
  return fds.some((fd) => {
    try {
      const stat = statSync(`/dev/fd/${fd}`);
      return stat.dev === target.dev && stat.ino === target.ino;
    } catch {
      return false;
    }
  });
}

export function createPrivateCopy(source: string, options: PrivateCopyOptions = {}): PrivateCopy {
  const main = statSync(source);
  if (!main.isFile()) refuse(`${source} is not a regular file`);
  if (!options.allowSourceOpenInThisProcessForTests && isOpenInThisProcess(main)) {
    refuse(
      `${source} is already open in this process; copying it would drop this process's SQLite locks`,
    );
  }
  if (options.requireNoSidecars) {
    const present = ALL_SIDECARS.filter((suffix) => existsSync(source + suffix));
    if (present.length > 0) {
      refuse(
        `${source} has ${present.join(", ")} next to it; an audit snapshot must be a single file`,
      );
    }
  }
  installExitHook();
  const dir = mkdtempSync(join(tmpdir(), "negotium-admin-"));
  try {
    openSafeDir(dir); // 0700, owned by us, not a symlink
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const before = COPIED_SUFFIXES.map((suffix) => stateOf(source, suffix));
      const contents = before.map((state) => (state ? readFileSync(source + state.suffix) : null));
      options.afterReadForTests?.();
      const after = COPIED_SUFFIXES.map((suffix) => stateOf(source, suffix));
      const lengthsMatch = contents.every(
        (bytes, index) => bytes === null || bytes.length === before[index]?.size,
      );
      if (!sameStates(before, after) || !lengthsMatch) continue;
      const path = join(dir, `copy-${attempt}.db`);
      const copiedSidecars: string[] = [];
      contents.forEach((bytes, index) => {
        if (!bytes) return;
        const suffix = COPIED_SUFFIXES[index] as string;
        writeNewFile(path + suffix, bytes);
        if (suffix) copiedSidecars.push(suffix);
      });
      const mainBytes = contents[0] as Buffer;
      const db = new Database(path, { readwrite: true, create: false });
      db.exec("PRAGMA busy_timeout = 1000");
      let closed = false;
      const copy: PrivateCopy = {
        source,
        dir,
        path,
        db,
        mainSha256: createHash("sha256").update(mainBytes).digest("hex"),
        mainSize: mainBytes.length,
        copiedSidecars,
        close() {
          if (closed) return;
          closed = true;
          openCopies.delete(copy);
          try {
            db.close();
          } catch {
            // already closed
          }
          rmSync(dir, { recursive: true, force: true });
        },
      };
      openCopies.add(copy);
      return copy;
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  rmSync(dir, { recursive: true, force: true });
  return refuse(
    `${source} kept changing while it was copied (${ATTEMPTS} attempts); stop the writer and retry`,
  );
}

/** Names, sizes and sha256 of a DB file and its sidecars (docs + tests: "unchanged"). */
export function dbFileListing(source: string): Record<string, { size: number; sha256: string }> {
  const listing: Record<string, { size: number; sha256: string }> = {};
  for (const suffix of ["", ...ALL_SIDECARS]) {
    const path = source + suffix;
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    listing[suffix || "(main)"] = {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return listing;
}
