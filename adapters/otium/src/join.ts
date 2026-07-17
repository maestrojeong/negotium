/**
 * otium node join credentials — the v0 "invite code" is a base64url JSON
 * bundle `{ v, central, cellId, secret }` produced by the hub operator
 * (scripts/otium-experiment/hub-setup.ts). `negotium otium join <code>` decodes it
 * and persists it under `${DATA_DIR}/otium-join.json` (0600); `serve` mounts
 * the peer routes whenever that file (or the env triple) is present.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DATA_DIR, logger } from "@negotium/core";
import { assertSecureCentralUrl, assertSecureRelayUrl } from "@/secure-transport";

export interface OtiumJoin {
  /** Invite code format version (v0 bundles carry 1). */
  v?: number;
  /** central-api origin, e.g. "http://127.0.0.1:4600". */
  central: string;
  /** Optional relay origin used for outbound NAT traversal. */
  relay?: string;
  /** This node's runtime cell id (cell_…). */
  cellId: string;
  /** This node's runtime cell secret (rcs_…) — never leaves this process. */
  secret: string;
}

export function joinFilePath(): string {
  return resolve(DATA_DIR, "otium-join.json");
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function isRelayUrl(value: string): boolean {
  return /^(?:https?|wss?):\/\//.test(value);
}

function normalizeJoin(raw: Record<string, unknown>): OtiumJoin {
  const central = typeof raw.central === "string" ? raw.central.trim().replace(/\/+$/, "") : "";
  const relay = typeof raw.relay === "string" ? raw.relay.trim().replace(/\/+$/, "") : "";
  const cellId = typeof raw.cellId === "string" ? raw.cellId.trim() : "";
  const secret = typeof raw.secret === "string" ? raw.secret.trim() : "";
  if (!central || !isHttpUrl(central)) {
    throw new Error("invite code is missing a valid http(s) central URL");
  }
  if (relay && !isRelayUrl(relay)) throw new Error("invite code has an invalid relay URL");
  if (!cellId) throw new Error("invite code is missing cellId");
  if (!secret) throw new Error("invite code is missing secret");
  assertSecureCentralUrl(central);
  if (relay) assertSecureRelayUrl(relay);
  return {
    ...(typeof raw.v === "number" ? { v: raw.v } : {}),
    central,
    ...(relay ? { relay } : {}),
    cellId,
    secret,
  };
}

/** Decode a v0 invite code: base64url(JSON {v, central, cellId, secret}). */
export function parseInviteCode(code: string): OtiumJoin {
  const trimmed = code.trim();
  if (!trimmed) throw new Error("invite code is empty");
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, "base64url").toString("utf-8");
  } catch {
    throw new Error("invite code is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("invite code does not decode to JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invite code does not decode to a JSON object");
  }
  return normalizeJoin(parsed as Record<string, unknown>);
}

export interface SaveJoinOptions {
  /** Explicitly replace credentials for a different cell/workspace. */
  replaceExisting?: boolean;
}

interface JoinLockOwner {
  pid: number;
  token: string;
}

const JOIN_LOCK_STALE_MS = 30_000;

function joinLockPath(): string {
  return resolve(DATA_DIR, ".otium-join.lock");
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** @internal Cross-process critical section for join/enrollment credential state. */
export function withJoinCredentialLock<T>(operation: () => T): T {
  const lockPath = joinLockPath();
  const ownerPath = resolve(lockPath, "owner.json");
  const owner: JoinLockOwner = { pid: process.pid, token: randomUUID() };
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; ; attempt += 1) {
    let created = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      const ownerFd = openSync(ownerPath, "r");
      try {
        fsyncSync(ownerFd);
      } finally {
        closeSync(ownerFd);
      }
      break;
    } catch (error) {
      if (created) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: JoinLockOwner | null = null;
      try {
        current = JSON.parse(readFileSync(ownerPath, "utf8")) as JoinLockOwner;
      } catch {
        // A live acquirer may be between mkdir and owner write. Only recover an
        // ownerless lock after it has been stale long enough.
      }
      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if ((current && processIsAlive(current.pid)) || (!current && ageMs <= JOIN_LOCK_STALE_MS)) {
        throw new Error(`another Otium join credential operation is in progress at ${lockPath}`);
      }
      if (attempt > 0) {
        throw new Error(`could not recover stale Otium join credential lock at ${lockPath}`);
      }
      const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
      try {
        renameSync(lockPath, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
      }
    }
  }

  try {
    return operation();
  } finally {
    try {
      const current = JSON.parse(readFileSync(ownerPath, "utf8")) as JoinLockOwner;
      if (current.pid === owner.pid && current.token === owner.token) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  }
}

function joinsEqual(left: OtiumJoin, right: OtiumJoin): boolean {
  return (
    left.central === right.central &&
    left.relay === right.relay &&
    left.cellId === right.cellId &&
    left.secret === right.secret
  );
}

function normalizedJoin(join: OtiumJoin): OtiumJoin {
  return normalizeJoin({
    v: join.v,
    central: join.central,
    relay: join.relay,
    cellId: join.cellId,
    secret: join.secret,
  });
}

/** Stable digest used to bind pending enrollment material to one exact join. */
export function joinCredentialDigest(join: OtiumJoin): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedJoin(join)))
    .digest("base64url");
}

function readPersistedJoin(path = joinFilePath()): OtiumJoin | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("persisted join credentials are not a JSON object");
  }
  return normalizeJoin(parsed as Record<string, unknown>);
}

/** True only when the join file on disk contains these exact credentials. */
export function isJoinPersisted(join: OtiumJoin): boolean {
  try {
    const persisted = readPersistedJoin();
    return persisted !== null && joinsEqual(persisted, normalizedJoin(join));
  } catch {
    return false;
  }
}

/**
 * Persist join credentials atomically (0600 — the cell secret is a bearer
 * credential). Re-saving the same join is idempotent. Replacing a different
 * join must be explicit so an enrollment retry cannot silently detach a node.
 */
/** @internal Caller must hold withJoinCredentialLock. */
export function saveJoinWhileLocked(join: OtiumJoin, options: SaveJoinOptions = {}): string {
  const path = joinFilePath();
  const directory = dirname(path);
  const normalized = normalizedJoin(join);
  mkdirSync(directory, { recursive: true });

  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to replace symlinked Otium join file at ${path}`);
    }
    let existing: OtiumJoin | null = null;
    try {
      existing = readPersistedJoin(path)!;
    } catch (error) {
      if (!options.replaceExisting) {
        throw new Error(
          `existing Otium join file at ${path} is invalid; pass --replace to replace it`,
          { cause: error },
        );
      }
    }
    if (existing && joinsEqual(existing, normalized)) {
      chmodSync(path, 0o600);
      const fileFd = openSync(path, "r");
      try {
        fsyncSync(fileFd);
      } finally {
        closeSync(fileFd);
      }
      const directoryFd = openSync(directory, "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
      return path;
    }
    if (!options.replaceExisting) {
      throw new Error(
        `this node is already joined${existing ? ` as ${existing.cellId}` : " with an invalid join file"}; pass --replace to replace its credentials`,
      );
    }
  }

  const temporaryPath = resolve(directory, `.otium-join.json.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (options.replaceExisting) {
      renameSync(temporaryPath, path);
    } else {
      // Unlike rename(), link fails when another process won the initial join
      // race, so a non-explicit save can never overwrite its credentials.
      linkSync(temporaryPath, path);
      unlinkSync(temporaryPath);
    }
    chmodSync(path, 0o600);
    const directoryFd = openSync(directory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
  return path;
}

export function saveJoin(join: OtiumJoin, options: SaveJoinOptions = {}): string {
  return withJoinCredentialLock(() => saveJoinWhileLocked(join, options));
}

/**
 * Load join credentials. Env triple (OTIUM_CENTRAL_URL / OTIUM_CELL_ID /
 * OTIUM_CELL_SECRET) wins when all three are set — same values `negotium
 * join` persists, useful for tests and multi-node-on-one-box. Fail-closed:
 * a partial env triple or a corrupt file yields null (worker stays off).
 */
export function loadJoin(): OtiumJoin | null {
  const central = process.env.OTIUM_CENTRAL_URL?.trim();
  const cellId = process.env.OTIUM_CELL_ID?.trim();
  const secret = process.env.OTIUM_CELL_SECRET?.trim();
  const relay = process.env.OTIUM_RELAY_URL?.trim();
  if (central && cellId && secret) {
    try {
      return normalizeJoin({ central, relay, cellId, secret });
    } catch (err) {
      logger.warn({ err }, "otium: invalid OTIUM_CENTRAL_URL/OTIUM_CELL_ID/OTIUM_CELL_SECRET env");
      return null;
    }
  }
  if (central || cellId || secret) {
    logger.warn(
      "otium: OTIUM_CENTRAL_URL, OTIUM_CELL_ID, OTIUM_CELL_SECRET must be set together — ignoring partial env",
    );
  }
  const path = joinFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeJoin(parsed as Record<string, unknown>);
  } catch (err) {
    logger.warn({ err, path }, "otium: failed to read join file");
    return null;
  }
}
