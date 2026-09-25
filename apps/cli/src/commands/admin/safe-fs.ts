/**
 * Safe directory + durable file model for admin backups (review finding 6).
 *
 * - A target directory must already exist or is created with mode 0700; it
 *   must be a real directory (never a symlink), owned by the current uid, and
 *   carry no group/other permission bits. Its (dev, ino) is pinned and
 *   re-checked before every write.
 * - Files are created with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, under a
 *   random basename that never contains a topic id.
 * - Durability order is fixed: fsync(file) → verify → no-clobber rename →
 *   fsync(dir). All four go through an injectable {@link FsSeam} so tests can
 *   observe the order and fail any step.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { refuse } from "./errors";

export interface FsSeam {
  fsyncFile(fd: number, path: string): void;
  fsyncDir(dir: string): void;
  /** No-clobber rename: fails if `to` exists. */
  renameNoClobber(from: string, to: string): void;
  /** Observation hook for tests (step name + path). */
  event?(step: string, path: string): void;
}

export const defaultFsSeam: FsSeam = {
  fsyncFile(fd) {
    fsyncSync(fd);
  },
  fsyncDir(dir) {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  renameNoClobber(from, to) {
    // link(2) fails with EEXIST instead of replacing; then drop the temp name.
    linkSync(from, to);
    unlinkSync(from);
  },
};

export interface SafeDir {
  path: string;
  dev: number;
  ino: number;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertSafeDirStat(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) refuse(`${path} is a symbolic link; pass a real directory`);
  if (!stat.isDirectory()) refuse(`${path} is not a directory`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    refuse(`${path} is owned by uid ${stat.uid}, not by the current user (${uid})`);
  }
  if ((stat.mode & 0o077) !== 0) {
    refuse(
      `${path} has mode ${(stat.mode & 0o777).toString(8)}; it must be private (0700, no group/other bits)`,
    );
  }
}

/**
 * Open (or create with 0700) a private directory. The parent must exist; a
 * missing parent is refused rather than created (`mkdir -p` would follow
 * whatever symlinks sit on the way).
 */
export function openSafeDir(pathOption: string): SafeDir {
  const path = resolve(pathOption);
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let parent: Stats;
    try {
      parent = lstatSync(dirname(path));
    } catch {
      refuse(`parent directory of ${path} does not exist`);
    }
    if (!parent.isDirectory()) refuse(`parent of ${path} is not a directory`);
    mkdirSync(path, { mode: 0o700 });
    stat = lstatSync(path);
  }
  assertSafeDirStat(path, stat);
  return { path, dev: stat.dev, ino: stat.ino };
}

/** Re-check a pinned directory right before a write (swap/chmod/symlink race). */
export function recheckSafeDir(dir: SafeDir): void {
  let stat: Stats;
  try {
    stat = lstatSync(dir.path);
  } catch {
    refuse(`${dir.path} disappeared`);
  }
  assertSafeDirStat(dir.path, stat);
  if (stat.dev !== dir.dev || stat.ino !== dir.ino) {
    refuse(`${dir.path} was replaced (dev/ino changed) since it was checked`);
  }
}

/** `<prefix>-<utc stamp>-<16 random hex>`; the prefix is sanitized, never an id. */
export function randomBasename(prefix: string, suffix: string): string {
  const safePrefix = prefix.replace(/[^a-z0-9-]/gi, "").slice(0, 32) || "admin";
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${safePrefix}-${stamp}-${randomBytes(8).toString("hex")}${suffix}`;
}

export interface ExclusiveFile {
  fd: number;
  path: string;
  dev: number;
  ino: number;
}

/** Create a brand-new 0600 file in `dir` (`O_EXCL|O_NOFOLLOW`), after a dir re-check. */
export function createExclusiveFile(dir: SafeDir, name: string): ExclusiveFile {
  if (basename(name) !== name || name.startsWith(".."))
    refuse(`bad file name ${JSON.stringify(name)}`);
  recheckSafeDir(dir);
  const path = join(dir.path, name);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) {
    closeSync(fd);
    refuse(`${path} is not a fresh regular file`);
  }
  return { fd, path, dev: stat.dev, ino: stat.ino };
}

/** The name still points at the inode we created (not swapped, not a link). */
export function assertSameFile(file: ExclusiveFile, path = file.path): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.dev !== file.dev || stat.ino !== file.ino) {
    refuse(`${path} is no longer the file this run created`);
  }
}
