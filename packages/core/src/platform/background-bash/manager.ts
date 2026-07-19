import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { BACKGROUND_BASH_SERVER, BG_BASH_BASE_PORT, BG_BASH_MAX_PORT } from "#platform/config";
import { delay } from "#platform/delay";
import { logger } from "#platform/logger";
import { deriveBgBashContextCapability } from "./context";

export function makeBgBashKey(_userId: string, _topic: string): string {
  return "runtime";
}

interface BgBashInstance {
  process: ChildProcess;
  port: number;
  startedAt: number;
  lastUsedAt: number;
}

export interface BackgroundBashManager {
  contextCapability(userId: string, topic: string): string;
  ensure(userId: string, topic: string): Promise<number>;
  clear(userId: string, topic: string): void;
  clearUser(userId: string): void;
  killAll(): Promise<void>;
}

export interface BackgroundBashManagerOptions {
  serverFile?: string;
  basePort?: number;
  maxPort?: number;
  capability?: string;
  serverId?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  portPids?: (port: number) => readonly number[];
  spawn?: (
    command: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcess;
}

function defaultPortPids(port: number): number[] {
  try {
    return execFileSync("lsof", ["-i", `:${port}`, "-t"], { stdio: "pipe" })
      .toString()
      .trim()
      .split("\n")
      .map((pid) => Number.parseInt(pid, 10))
      .filter((pid) => !Number.isNaN(pid));
  } catch {
    return [];
  }
}

/** Create a fully isolated manager. All mutable process/port/context state belongs to the caller. */
export function createBackgroundBashManager(
  options: BackgroundBashManagerOptions = {},
): BackgroundBashManager {
  const instances = new Map<string, BgBashInstance>();
  const usedPorts = new Set<number>();
  const spawning = new Map<string, Promise<number>>();
  const knownContexts = new Map<string, { userId: string; topic: string }>();
  const runtimeCapability = options.capability ?? randomBytes(32).toString("hex");
  const runtimeServerId = options.serverId ?? randomBytes(16).toString("hex");
  const serverFile = options.serverFile ?? BACKGROUND_BASH_SERVER;
  const basePort = options.basePort ?? BG_BASH_BASE_PORT;
  const maxPort = options.maxPort ?? BG_BASH_MAX_PORT;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const wait = options.delay ?? delay;
  const portPids = options.portPids ?? defaultPortPids;
  const spawnImpl =
    options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));

  function contextKey(userId: string, topic: string): string {
    return `${userId}\0${topic}`;
  }

  function contextCapability(userId: string, topic: string): string {
    return deriveBgBashContextCapability(runtimeCapability, userId, topic);
  }

  async function allocatePort(excludedPorts: ReadonlySet<number> = new Set()): Promise<number> {
    for (let port = basePort; port <= maxPort; port++) {
      if (usedPorts.has(port) || excludedPorts.has(port)) continue;
      usedPorts.add(port);
      if (portPids(port).length > 0) {
        usedPorts.delete(port);
        continue;
      }
      return port;
    }
    throw new Error(
      `No available ports for background-bash (range ${basePort}-${maxPort}, ${instances.size} active)`,
    );
  }

  async function isHealthy(port: number): Promise<boolean> {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok && (await response.text()) === runtimeServerId;
    } catch {
      return false;
    }
  }

  function killRuntime(): void {
    const key = "runtime";
    const instance = instances.get(key);
    if (!instance) return;
    try {
      instance.process.kill("SIGTERM");
    } catch {}
    usedPorts.delete(instance.port);
    instances.delete(key);
    logger.info({ key, port: instance.port }, "background-bash server killed");
  }

  async function spawnServer(
    key: string,
    reservedPort?: number,
    excludedPorts: ReadonlySet<number> = new Set(),
  ): Promise<number> {
    const port = reservedPort ?? (await allocatePort(excludedPorts));
    const process = spawnImpl("bun", ["run", serverFile, `--port=${port}`], {
      stdio: "ignore",
      detached: false,
      env: {
        ...(options.env ?? globalThis.process.env),
        NEGOTIUM_BG_BASH_CAPABILITY: runtimeCapability,
        NEGOTIUM_BG_BASH_SERVER_ID: runtimeServerId,
      },
    });

    process.once("error", (error) => {
      logger.error({ err: error, key }, "background-bash server error");
      if (instances.get(key)?.process === process) {
        usedPorts.delete(port);
        instances.delete(key);
      }
    });
    process.once("exit", (code) => {
      logger.info({ key, code }, "background-bash server exited");
      if (instances.get(key)?.process === process) {
        usedPorts.delete(port);
        instances.delete(key);
      }
    });

    const timestamp = now();
    instances.set(key, { process, port, startedAt: timestamp, lastUsedAt: timestamp });
    const started = now();
    while (now() - started < 8_000) {
      if (process.exitCode !== null) {
        const nextExcluded = new Set(excludedPorts);
        nextExcluded.add(port);
        return spawnServer(key, undefined, nextExcluded);
      }
      if (await isHealthy(port)) return port;
      await wait(200);
    }
    killRuntime();
    throw new Error(`background-bash server failed health check after spawn on port ${port}`);
  }

  async function ensure(userId: string, topic: string): Promise<number> {
    const key = makeBgBashKey(userId, topic);
    knownContexts.set(contextKey(userId, topic), { userId, topic });
    const inProgress = spawning.get(key);
    if (inProgress) return inProgress;

    const promise = (async () => {
      const existing = instances.get(key);
      if (existing && !existing.process.killed && existing.process.exitCode === null) {
        if (await isHealthy(existing.port)) {
          existing.lastUsedAt = now();
          return existing.port;
        }
        killRuntime();
      } else if (existing) {
        usedPorts.delete(existing.port);
        instances.delete(key);
      }
      return spawnServer(key);
    })().finally(() => spawning.delete(key));
    spawning.set(key, promise);
    return promise;
  }

  function clear(userId: string, topic: string): void {
    knownContexts.delete(contextKey(userId, topic));
    const instance = instances.get("runtime");
    if (!instance) return;
    const query = new URLSearchParams({
      user: userId,
      topic,
      capability: contextCapability(userId, topic),
    });
    void fetchImpl(`http://127.0.0.1:${instance.port}/contexts?${query}`, {
      method: "DELETE",
    }).catch(() => {});
  }

  function clearUser(userId: string): void {
    for (const context of [...knownContexts.values()]) {
      if (context.userId === userId) clear(context.userId, context.topic);
    }
  }

  async function killAll(): Promise<void> {
    const entries = [...instances.values()];
    for (const instance of entries) {
      try {
        instance.process.kill("SIGTERM");
      } catch {}
    }
    instances.clear();
    usedPorts.clear();
    knownContexts.clear();
    const deadline = now() + 3000;
    await Promise.all(
      entries.map(
        (instance) =>
          new Promise<void>((resolve) => {
            if (instance.process.exitCode !== null || instance.process.killed) return resolve();
            instance.process.once("exit", resolve);
            instance.process.once("error", resolve);
            const timer = setTimeout(resolve, Math.max(0, deadline - now()));
            timer.unref?.();
          }),
      ),
    );
  }

  return { contextCapability, ensure, clear, clearUser, killAll };
}

const defaultManager = createBackgroundBashManager();

export const bgBashContextCapability = defaultManager.contextCapability;
export const ensureBgBash = defaultManager.ensure;
export const killBgBash = defaultManager.clear;
export const killBgBashForUser = defaultManager.clearUser;
export const killAllBgBash = defaultManager.killAll;
