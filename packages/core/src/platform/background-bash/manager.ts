import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { BACKGROUND_BASH_SERVER, BG_BASH_BASE_PORT, BG_BASH_MAX_PORT } from "#platform/config";
import { delay } from "#platform/delay";
import { logger } from "#platform/logger";

// --- Instance key (mirrors Playwright manager convention) ---

export function makeBgBashKey(_userId: string, topic: string): string {
  return `topic:${topic}`;
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

function processCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { stdio: "pipe" })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function isBackgroundBashServerProcess(cmdline: string, port: number): boolean {
  return cmdline.includes("background-bash-server.ts") && cmdline.includes(`--port=${port}`);
}

async function killBackgroundBashOnPort(port: number): Promise<void> {
  for (const pid of pidsOnPort(port)) {
    const cmdline = processCommand(pid);
    if (!isBackgroundBashServerProcess(cmdline, port)) {
      logger.warn(
        { port, pid, cmdline: cmdline.slice(0, 120) },
        "background-bash port occupied by non-background-bash process; skipping",
      );
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      logger.info({ port, pid }, "Killed zombie background-bash server");
    } catch (e) {
      logger.warn({ err: e, port, pid }, "Failed to kill zombie background-bash server");
    }
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isPortInUse(port)) return;
    await delay(100);
  }
}

async function allocatePort(): Promise<number> {
  for (let port = BG_BASH_BASE_PORT; port <= BG_BASH_MAX_PORT; port++) {
    if (usedPorts.has(port)) continue;
    usedPorts.add(port); // reserve before any await
    if (isPortInUse(port)) {
      await killBackgroundBashOnPort(port);
      if (isPortInUse(port)) {
        usedPorts.delete(port);
        continue;
      }
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
    res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

// --- Spawn ---

async function spawnBgBash(
  key: string,
  userId: string,
  topic: string,
  reservedPort?: number,
): Promise<number> {
  const port = reservedPort ?? (await allocatePort());

  const serverArgs = [
    "run",
    BACKGROUND_BASH_SERVER,
    `--user-id=${userId}`,
    `--topic=${topic}`,
    `--port=${port}`,
  ];

  const proc = spawn("bun", serverArgs, {
    stdio: "ignore",
    detached: false,
    env: { ...process.env },
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
    if (await isHealthy(port)) {
      logger.info({ key, port, pid: proc.pid }, "background-bash server ready");
      return port;
    }
    await delay(200);
  }
  killBgBash(userId, topic);
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
      killBgBash(userId, topic);
    } else if (existing) {
      usedPorts.delete(existing.port);
      instances.delete(key);
    }

    return spawnBgBash(key, userId, topic);
  })().finally(() => spawning.delete(key));
  spawning.set(key, promise);
  return promise;
}

export function killBgBash(userId: string, topic: string): void {
  const key = makeBgBashKey(userId, topic);
  const inst = instances.get(key);
  if (!inst) return;
  try {
    inst.process.kill("SIGTERM");
  } catch {}
  usedPorts.delete(inst.port);
  instances.delete(key);
  logger.info({ key, port: inst.port }, "background-bash server killed");
}

export function killBgBashForUser(_userId: string): void {
  for (const key of [...instances.keys()]) {
    const inst = instances.get(key);
    if (!inst) continue;
    try {
      inst.process.kill("SIGTERM");
    } catch {}
    usedPorts.delete(inst.port);
    instances.delete(key);
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

// Evict idle instances every 30 minutes (2hr idle threshold)
const MAX_IDLE_MS = 2 * 60 * 60 * 1000;
setInterval(
  () => {
    const now = Date.now();
    for (const [key, inst] of instances) {
      if (now - inst.lastUsedAt > MAX_IDLE_MS) {
        logger.info({ key }, "evicting idle background-bash server");
        try {
          inst.process.kill("SIGTERM");
        } catch {}
        usedPorts.delete(inst.port);
        instances.delete(key);
      }
    }
  },
  30 * 60 * 1000,
).unref();
