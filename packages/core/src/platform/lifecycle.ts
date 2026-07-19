import { logger } from "#platform/logger";

export interface ShutdownHandler {
  name: string;
  priority: number;
  fn: () => Promise<void> | void;
}

export type SignalReason = "beforeExit" | "SIGINT" | "SIGTERM" | "test";

export interface LifecycleLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface LifecycleProcessHost {
  once(event: "beforeExit" | "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "beforeExit" | "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): never;
}

export interface LifecycleManagerOptions {
  logger: LifecycleLogger;
  process: LifecycleProcessHost;
  handlerTimeoutMs?: number;
  hardExitTimeoutMs?: number;
}

export interface LifecycleManager {
  onShutdown(name: string, priority: number, fn: () => Promise<void> | void): void;
  runShutdown(reason: SignalReason): Promise<void>;
  reset(): void;
  handlerCount(): number;
  isTriggered(): boolean;
}

const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;
const DEFAULT_HARD_EXIT_TIMEOUT_MS = 15_000;

/**
 * Create an isolated shutdown registry. Callers own the registry and process
 * hooks, so embedding this helper cannot collide with another runtime's
 * handlers or test state.
 */
export function createLifecycleManager(options: LifecycleManagerOptions): LifecycleManager {
  const handlers: ShutdownHandler[] = [];
  const signalListeners = new Map<"beforeExit" | "SIGINT" | "SIGTERM", () => void>();
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const hardExitTimeoutMs = options.hardExitTimeoutMs ?? DEFAULT_HARD_EXIT_TIMEOUT_MS;
  let signalHooksInstalled = false;
  let triggered = false;
  let shutdownPromise: Promise<void> | null = null;

  function ensureSignalHooks(): void {
    if (signalHooksInstalled) return;
    signalHooksInstalled = true;
    for (const signal of ["beforeExit", "SIGINT", "SIGTERM"] as const) {
      const listener = () => {
        void runShutdown(signal);
      };
      signalListeners.set(signal, listener);
      options.process.once(signal, listener);
    }
  }

  function onShutdown(name: string, priority: number, fn: () => Promise<void> | void): void {
    handlers.push({ name, priority, fn });
    ensureSignalHooks();
  }

  async function performShutdown(reason: SignalReason): Promise<void> {
    options.logger.info(
      { reason, handlerCount: handlers.length },
      "lifecycle: shutdown sequence starting",
    );
    const ordered = handlers
      .map((handler, index) => ({ handler, index }))
      .sort((a, b) => b.handler.priority - a.handler.priority || a.index - b.index)
      .map(({ handler }) => handler);

    const hardExit = setTimeout(() => {
      options.logger.error(
        { reason },
        "lifecycle: hard-exit ceiling reached, forcing process.exit",
      );
      options.process.exit(1);
    }, hardExitTimeoutMs);
    hardExit.unref?.();

    for (const handler of ordered) {
      const start = Date.now();
      let handlerTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => handler.fn()),
          new Promise<void>((_, reject) => {
            handlerTimeout = setTimeout(
              () => reject(new Error("handler timeout")),
              handlerTimeoutMs,
            );
          }),
        ]);
        options.logger.info(
          { handler: handler.name, priority: handler.priority, ms: Date.now() - start },
          "lifecycle: shutdown handler completed",
        );
      } catch (error) {
        options.logger.warn(
          { error, handler: handler.name, priority: handler.priority, ms: Date.now() - start },
          "lifecycle: shutdown handler failed or timed out (continuing)",
        );
      } finally {
        if (handlerTimeout) clearTimeout(handlerTimeout);
      }
    }

    clearTimeout(hardExit);
    options.logger.info({ reason }, "lifecycle: shutdown sequence complete");
  }

  function runShutdown(reason: SignalReason): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    triggered = true;
    shutdownPromise = performShutdown(reason);
    return shutdownPromise;
  }

  function reset(): void {
    handlers.length = 0;
    triggered = false;
    shutdownPromise = null;
    for (const [signal, listener] of signalListeners) {
      options.process.removeListener(signal, listener);
    }
    signalListeners.clear();
    signalHooksInstalled = false;
  }

  return {
    onShutdown,
    runShutdown,
    reset,
    handlerCount: () => handlers.length,
    isTriggered: () => triggered,
  };
}

const defaultLifecycle = createLifecycleManager({
  logger,
  process,
});

export const onShutdown = defaultLifecycle.onShutdown;
export const runShutdown = defaultLifecycle.runShutdown;

export function __resetForTests(): void {
  defaultLifecycle.reset();
}

export function __handlerCount(): number {
  return defaultLifecycle.handlerCount();
}

export function __triggered(): boolean {
  return defaultLifecycle.isTriggered();
}
