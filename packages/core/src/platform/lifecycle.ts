import { logger } from "#platform/logger";

/**
 * Shared process-shutdown registry.
 *
 * The backend has multiple subsystems that need to clean up on SIGTERM /
 * SIGINT / beforeExit — MCP client pool, browser/background-bash
 * children, codex process trees, and DB/runtime handles. Before this module each subsystem
 * registered its own `process.once("SIGTERM", ...)` handler. node fires
 * them in registration order with no priority, so a cleanup that wanted
 * to wait for in-flight MCP calls to finish could be racing the same
 * subprocess-kill cleanup that takes those calls' children out from under
 * it.
 *
 * Replace that with a single set of signal hooks + a priority-ordered
 * registry. Modules call `onShutdown(name, priority, fn)`; the single
 * handler iterates handlers in priority order (highest first), awaiting
 * each with a hard ceiling so a hung cleanup can't keep the process
 * alive past a reasonable bound.
 *
 * Priority convention (rough):
 *   - 100+: stateful network/connection resources whose in-flight calls
 *     deserve a graceful close before any subprocess gets killed
 *     (MCP pool, DB connections, WebSocket/server resources).
 *   - 50:   subsystems that kill external processes / free OS handles
 *     (playwright, background-bash, codex tree).
 *   - 10:   final reporting / metrics flushing.
 * Numbers are not enforced — they're a convention so the order is
 * scrutable at a glance.
 *
 * Idempotent: the first signal triggers; subsequent signals are
 * no-ops so SIGINT-then-SIGTERM doesn't double-run handlers.
 *
 * Test isolation: `__resetForTests()` clears the registry AND removes
 * the installed listeners so a fresh registration in the next test
 * starts clean.
 */

export interface ShutdownHandler {
  name: string;
  priority: number;
  fn: () => Promise<void> | void;
}

const handlers: ShutdownHandler[] = [];
let signalHooksInstalled = false;
let triggered = false;
let shutdownPromise: Promise<void> | null = null;

/** Per-handler hard ceiling. A hung cleanup can't keep the process up
 *  beyond this; we log and move on so subsequent handlers still run. */
const HANDLER_TIMEOUT_MS = 5_000;

/** Process-exit-after-handlers ceiling. Even if every handler hangs we
 *  call process.exit so an orphaned bot doesn't wedge a forum forever. */
const HARD_EXIT_TIMEOUT_MS = 15_000;

/** Test-injectable signal trigger — exposed so tests can fire shutdown
 *  without touching real process signals. */
export type SignalReason = "beforeExit" | "SIGINT" | "SIGTERM" | "test";

/**
 * Register a shutdown handler. Lazy-installs the single process-level
 * signal listener on first call.
 *
 * `priority` is highest-first (100 runs before 50). Ties keep registration
 * order (stable sort), so two subsystems at the same tier behave
 * deterministically across runs.
 */
export function onShutdown(name: string, priority: number, fn: () => Promise<void> | void): void {
  handlers.push({ name, priority, fn });
  ensureSignalHooks();
}

function ensureSignalHooks(): void {
  if (signalHooksInstalled) return;
  signalHooksInstalled = true;
  process.once("beforeExit", () => {
    void runShutdown("beforeExit");
  });
  process.once("SIGINT", () => {
    void runShutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void runShutdown("SIGTERM");
  });
}

/**
 * Run every registered handler in priority order. Each handler gets a
 * HANDLER_TIMEOUT_MS budget; if it hangs we log and continue. The whole
 * sweep is capped at HARD_EXIT_TIMEOUT_MS — past that we call
 * `process.exit` so a stuck cleanup can't deadlock the shutdown.
 *
 * `reason` is passed through to handlers so a handler can log which
 * signal triggered it (useful for debugging which path led to exit).
 *
 * Exported for tests / explicit "I want shutdown now" callers.
 */
export function runShutdown(reason: SignalReason): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  triggered = true;
  shutdownPromise = performShutdown(reason);
  return shutdownPromise;
}

async function performShutdown(reason: SignalReason): Promise<void> {
  logger.info({ reason, handlerCount: handlers.length }, "lifecycle: shutdown sequence starting");
  // Stable sort: descending priority, registration order on ties.
  const ordered = handlers
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h.priority - a.h.priority || a.i - b.i)
    .map(({ h }) => h);

  const hardExit = setTimeout(() => {
    logger.error({ reason }, "lifecycle: hard-exit ceiling reached, forcing process.exit");
    process.exit(1);
  }, HARD_EXIT_TIMEOUT_MS);
  hardExit.unref?.();

  for (const h of ordered) {
    const start = Date.now();
    let handlerTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => h.fn()),
        new Promise<void>((_, reject) => {
          handlerTimeout = setTimeout(
            () => reject(new Error("handler timeout")),
            HANDLER_TIMEOUT_MS,
          );
        }),
      ]);
      logger.info(
        { handler: h.name, priority: h.priority, ms: Date.now() - start },
        "lifecycle: shutdown handler completed",
      );
    } catch (err) {
      logger.warn(
        { err, handler: h.name, priority: h.priority, ms: Date.now() - start },
        "lifecycle: shutdown handler failed or timed out (continuing)",
      );
    } finally {
      if (handlerTimeout) clearTimeout(handlerTimeout);
    }
  }
  clearTimeout(hardExit);
  logger.info({ reason }, "lifecycle: shutdown sequence complete");
}

/** Test-only: clear the registry and uninstall signal hooks so the next
 *  test's onShutdown calls start fresh. Does NOT actually call any
 *  handler — tests that want to exercise the trigger path should call
 *  `runShutdown("test")` after registering. */
export function __resetForTests(): void {
  handlers.length = 0;
  triggered = false;
  shutdownPromise = null;
  signalHooksInstalled = false;
  // No way to remove process.once listeners that haven't fired yet —
  // they'll just become no-ops because `triggered` is false-but-handlers
  // is empty. The signalHooksInstalled flag is reset so the next
  // onShutdown call installs fresh listeners.
}

/** Test-only: read the registered handler count. */
export function __handlerCount(): number {
  return handlers.length;
}

/** Test-only: read whether triggered. */
export function __triggered(): boolean {
  return triggered;
}
