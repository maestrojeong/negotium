/**
 * Starvation-free trigger coalescing for workers driven by *both* an irregular
 * event source (fs.watch, in-process signals) and a periodic safety net poll.
 *
 * Why this exists instead of `debouncedFlush`
 * -------------------------------------------
 * A trailing-edge debounce re-arms its timer on every trigger. When any trigger
 * source fires faster than the debounce delay the quiet window never arrives
 * and the work is postponed forever — the exact self-starving regression that a
 * 100ms fallback poll feeding a 200ms debounce produced (b919a2e).
 *
 * The invariant here is the opposite one:
 *
 *   Once a run is armed, nothing can push it further out.
 *
 * A trigger only ever *creates* a timer; it never clears or reschedules one.
 * Extra triggers arriving before that timer fires are absorbed for free, so a
 * high trigger rate makes the run happen sooner, never later.
 *
 *   trigger() ──► running?  ── yes ─► pending = true            (run again after)
 *                    │ no
 *                    ▼
 *                 armed?  ── yes ─► drop (already guaranteed to run)
 *                    │ no
 *                    ▼
 *          wait = max(0, lastStart + minIntervalMs - now)
 *          wait === 0 ─► run immediately          (leading edge: ~0 latency)
 *          wait  >  0 ─► setTimeout(run, wait)    (bounded: ≤ minIntervalMs)
 *
 * Consequences:
 *  - Latency: an idle worker runs on the *leading* edge, so a single message is
 *    picked up immediately. Inside a burst the worst case is `minIntervalMs`.
 *  - Throughput cap: runs start at most once per `minIntervalMs`, so a chatty
 *    watcher (including events caused by the run's own writes) cannot spin.
 *  - Coalescing: triggers landing while a run is in flight collapse into a
 *    single follow-up run scheduled once the current one settles.
 */

import { logger as defaultLogger } from "#platform/logger";

export interface CoalescingRunnerLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface CoalescingRunnerOptions {
  /** The work to coalesce. Rejections are logged, never propagated. */
  run: () => Promise<void> | void;
  /** Log label. */
  label: string;
  /**
   * Minimum gap between the *starts* of two consecutive runs, and therefore the
   * upper bound on how long a trigger can wait for one. `0` runs on every
   * trigger.
   */
  minIntervalMs: number;
  logger?: CoalescingRunnerLogger;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

export interface CoalescingRunner {
  /** Request a run "as soon as the rate limit allows". Never delays a pending one. */
  trigger(): void;
  /** Run now, ignoring the rate limit (boot drain). Resolves when that run settles. */
  runNow(): Promise<void>;
  /** Release timers. Further triggers are ignored; an in-flight run is not cancelled. */
  stop(): void;
  /** Completed + in-flight run count. Test/diagnostics only. */
  readonly runCount: number;
  /** True while a run is in flight. Test/diagnostics only. */
  readonly isRunning: boolean;
}

export function createCoalescingRunner(options: CoalescingRunnerOptions): CoalescingRunner {
  const { run, label, minIntervalMs } = options;
  const log = options.logger ?? defaultLogger;
  const now = options.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let stopped = false;
  let lastStart: number | null = null;
  let runCount = 0;

  function arm(): void {
    if (stopped || running || timer) return;
    const wait = lastStart === null ? 0 : Math.max(0, lastStart + minIntervalMs - now());
    if (wait <= 0) {
      void execute();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, wait);
    timer.unref?.();
  }

  async function execute(): Promise<void> {
    if (stopped || running) return;
    running = true;
    pending = false;
    lastStart = now();
    runCount++;
    try {
      await run();
    } catch (err) {
      log.error({ err, label }, `${label}: Unhandled error`);
    } finally {
      running = false;
      if (pending && !stopped) {
        pending = false;
        // Re-arm through the normal path so the rate limit still applies. A run
        // that outlasted `minIntervalMs` re-runs immediately.
        arm();
      }
    }
  }

  return {
    trigger(): void {
      if (stopped) return;
      if (running) {
        pending = true;
        return;
      }
      arm();
    },
    async runNow(): Promise<void> {
      if (stopped) return;
      if (running) {
        pending = true;
        return;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await execute();
    },
    stop(): void {
      stopped = true;
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    get runCount(): number {
      return runCount;
    },
    get isRunning(): boolean {
      return running;
    },
  };
}
