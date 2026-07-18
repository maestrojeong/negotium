import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BACKGROUND_BASH_SERVER, BG_BASH_BASE_PORT, BG_BASH_MAX_PORT } from "#platform/config";
import { delay } from "#platform/delay";
import { logger } from "#platform/logger";
import { deriveBgBashContextCapability } from "./context";

// --- Instance key (mirrors Playwright manager convention) ---

export function makeBgBashKey(_userId: string, _topic: string): string {
  return "runtime";
}

// --- State ---

interface BgBashInstance {
  process: ChildProcess;
  port: number;
  startedAt: number;
  lastUsedAt: number;
}

const instances = new Map<string, BgBashInstance>();
const usedPorts = new Set<number>();
const spawning = new Map<string, Promise<number>>();
const runtimeCapability = randomBytes(32).toString("hex");
const runtimeServerId = randomBytes(16).toString("hex");
const knownContexts = new Map<string, { userId: string; topic: string }>();

function contextKey(userId: string, topic: string): string {
  return `${userId}\0${topic}`;
}

export function bgBashContextCapability(userId: string, topic: string): string {
  return deriveBgBashContextCapability(runtimeCapability, userId, topic);
}

// --- Port allocation ---

function pidsOnPort(port: number): number[] {
  try {
    return execFileSync("lsof", ["-i", `:${port}`, "-t"], { stdio: "pipe" })
      .toString()
      .trim()
      .split("\n")
      .map((pid) => parseInt(pid, 10))
      .filter((pid) => !Number.isNaN(pid));
  } catch {
    return [];
  }
}

function isPortInUse(port: number): boolean {
  return pidsOnPort(port).length > 0;
}

async function allocatePort(excludedPorts: ReadonlySet<number> = new Set()): Promise<number> {
  for (let port = BG_BASH_BASE_PORT; port <= BG_BASH_MAX_PORT; port++) {
    if (usedPorts.has(port) || excludedPorts.has(port)) continue;
    usedPorts.add(port); // reserve before any await
    if (isPortInUse(port)) {
      // Another runtime may legitimately own this port. Never infer that it
      // is a zombie from its command path; two runtimes can launch the same
      // installed server file. Skip it and use the next port instead.
      usedPorts.delete(port);
      continue;
    }
    return port;
  }
  throw new Error(
    `No available ports for background-bash (range ${BG_BASH_BASE_PORT}-${BG_BASH_MAX_PORT}, ${instances.size} active)`,
  );
}

// --- Health check ---

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok && (await res.text()) === runtimeServerId;
  } catch {
    return false;
  }
}

// --- Spawn ---

async function spawnBgBash(
  key: string,
  reservedPort?: number,
  excludedPorts: ReadonlySet<number> = new Set(),
): Promise<number> {
  const port = reservedPort ?? (await allocatePort(excludedPorts));

  const serverArgs = ["run", BACKGROUND_BASH_SERVER, `--port=${port}`];

  const proc = spawn("bun", serverArgs, {
    stdio: "ignore",
    detached: false,
    env: {
      ...process.env,
      NEGOTIUM_BG_BASH_CAPABILITY: runtimeCapability,
      NEGOTIUM_BG_BASH_SERVER_ID: runtimeServerId,
    },
  });

  proc.once("error", (err) => {
    logger.error({ err, key }, "background-bash server error");
    if (instances.get(key)?.process === proc) {
      usedPorts.delete(port);
      instances.delete(key);
    }
  });

  proc.once("exit", (code) => {
    logger.info({ key, code }, "background-bash server exited");
    if (instances.get(key)?.process === proc) {
      usedPorts.delete(port);
      instances.delete(key);
    }
  });

  const now = Date.now();
  instances.set(key, { process: proc, port, startedAt: now, lastUsedAt: now });

  // Wait for health
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    if (proc.exitCode !== null) {
      const nextExcludedPorts = new Set(excludedPorts);
      nextExcludedPorts.add(port);
      return spawnBgBash(key, undefined, nextExcludedPorts);
    }
    if (await isHealthy(port)) {
      logger.info({ key, port, pid: proc.pid }, "background-bash server ready");
      return port;
    }
    await delay(200);
  }
  killRuntimeBgBash();
  throw new Error(`background-bash server failed health check after spawn on port ${port}`);
}

// --- Public API ---

/**
 * Ensure a background-bash HTTP server is running for this (user, topic).
 * Reuses existing healthy instances; respawns on failure.
 * Returns the HTTP port to use in MCP config.
 */
export async function ensureBgBash(userId: string, topic: string): Promise<number> {
  const key = makeBgBashKey(userId, topic);
  knownContexts.set(contextKey(userId, topic), { userId, topic });

  const inProgress = spawning.get(key);
  if (inProgress) return inProgress;

  // Health-check → kill → spawn runs INSIDE the spawning promise: the old
  // shape awaited isHealthy() between the guard check and spawning.set(), so
  // two concurrent callers could both pass the guard — one killing the
  // instance the other had just spawned, or double-spawning and leaking the
  // first process's port from usedPorts. No await sits between the guard
  // above and spawning.set() below, so the guard is airtight on a
  // single-threaded event loop. (Same fix as playwright's ensurePlaywright.)
  const promise = (async (): Promise<number> => {
    const existing = instances.get(key);
    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      if (await isHealthy(existing.port)) {
        existing.lastUsedAt = Date.now();
        return existing.port;
      }
      killRuntimeBgBash();
    } else if (existing) {
      usedPorts.delete(existing.port);
      instances.delete(key);
    }

    return spawnBgBash(key);
  })().finally(() => spawning.delete(key));
  spawning.set(key, promise);
  return promise;
}

function killRuntimeBgBash(): void {
  const key = "runtime";
  const inst = instances.get(key);
  if (!inst) return;
  try {
    inst.process.kill("SIGTERM");
  } catch {}
  usedPorts.delete(inst.port);
  instances.delete(key);
  logger.info({ key, port: inst.port }, "background-bash server killed");
}

function clearContext(userId: string, topic: string): void {
  knownContexts.delete(contextKey(userId, topic));
  const inst = instances.get("runtime");
  if (!inst) return;
  const query = new URLSearchParams({
    user: userId,
    topic,
    capability: bgBashContextCapability(userId, topic),
  });
  void fetch(`http://127.0.0.1:${inst.port}/contexts?${query}`, { method: "DELETE" }).catch(
    () => {},
  );
}

export function killBgBash(userId: string, topic: string): void {
  clearContext(userId, topic);
}

export function killBgBashForUser(userId: string): void {
  for (const context of [...knownContexts.values()]) {
    if (context.userId === userId) clearContext(context.userId, context.topic);
  }
}

export async function killAllBgBash(): Promise<void> {
  const entries = [...instances.entries()];
  for (const [, inst] of entries) {
    try {
      inst.process.kill("SIGTERM");
    } catch {}
  }
  instances.clear();
  usedPorts.clear();
  knownContexts.clear();

  const deadline = Date.now() + 3000;
  await Promise.all(
    entries.map(
      ([, inst]) =>
        new Promise<void>((resolve) => {
          if (inst.process.exitCode !== null || inst.process.killed) {
            resolve();
            return;
          }
          inst.process.once("exit", () => resolve());
          inst.process.once("error", () => resolve());
          const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          t.unref?.();
        }),
    ),
  );
}
