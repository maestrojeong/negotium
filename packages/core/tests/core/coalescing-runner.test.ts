import { describe, expect, test } from "bun:test";
import { createCoalescingRunner } from "#outbox/coalescing-runner";
import { debouncedFlush } from "#outbox/utils";
import {
  SESSION_INBOX_COALESCE_MS,
  SESSION_INBOX_POLL_MS,
  SESSION_INBOX_POLL_WITHOUT_WATCH_MS,
} from "#runtime/inbox";

const silent = { error: () => {} };

/** Drive `tick()` every `everyMs` for `durationMs`, then stop. */
async function pulse(everyMs: number, durationMs: number, tick: () => void): Promise<void> {
  const timer = setInterval(tick, everyMs);
  try {
    await Bun.sleep(durationMs);
  } finally {
    clearInterval(timer);
  }
}

describe("coalescing runner", () => {
  test("runs on the leading edge so an idle worker has no trigger latency", async () => {
    let runs = 0;
    const runner = createCoalescingRunner({
      run: () => {
        runs++;
      },
      label: "t",
      minIntervalMs: 100,
      logger: silent,
    });
    runner.trigger();
    // Synchronous leading edge — not even a macrotask of delay.
    expect(runs).toBe(1);
    runner.stop();
  });

  test("a trigger source faster than the coalescing window cannot starve the run", async () => {
    let runs = 0;
    const runner = createCoalescingRunner({
      run: () => {
        runs++;
      },
      label: "t",
      minIntervalMs: 100,
      logger: silent,
    });

    await pulse(10, 600, () => runner.trigger());
    runner.stop();

    // ~6 windows of 100ms. Bounded on both sides: it must make progress, and
    // the rate limit must still hold (a 10ms trigger rate must not mean 60 runs).
    expect(runs).toBeGreaterThanOrEqual(4);
    expect(runs).toBeLessThanOrEqual(9);
  });

  test("the old debounce starves under the very same trigger rate", async () => {
    // Pins the b919a2e failure mode so the contrast stays visible: this is what
    // `debouncedFlush(flush, "session-inbox", 200)` did with a 100ms poll.
    let runs = 0;
    const trigger = debouncedFlush(
      async () => {
        runs++;
      },
      "legacy-debounce",
      200,
    );

    await pulse(100, 600, () => trigger());
    expect(runs).toBe(0);

    // ...and only fires once the trigger source goes quiet.
    await Bun.sleep(300);
    expect(runs).toBe(1);
  });

  test("triggers during a run collapse into exactly one follow-up run", async () => {
    let runs = 0;
    const gate = Promise.withResolvers<void>();
    const runner = createCoalescingRunner({
      run: async () => {
        runs++;
        if (runs === 1) await gate.promise;
      },
      label: "t",
      minIntervalMs: 0,
      logger: silent,
    });

    runner.trigger();
    expect(runs).toBe(1);
    for (let i = 0; i < 50; i++) runner.trigger();
    expect(runs).toBe(1);

    gate.resolve();
    await Bun.sleep(20);
    expect(runs).toBe(2);
    runner.stop();
  });

  test("stop() disarms pending timers and ignores later triggers", async () => {
    let runs = 0;
    const runner = createCoalescingRunner({
      run: () => {
        runs++;
      },
      label: "t",
      minIntervalMs: 50,
      logger: silent,
    });

    runner.trigger(); // leading edge
    runner.trigger(); // arms a timer 50ms out
    expect(runs).toBe(1);
    runner.stop();

    runner.trigger();
    await Bun.sleep(150);
    expect(runs).toBe(1);
  });

  test("restarting produces independent runners with no leaked timers", async () => {
    let runs = 0;
    for (let term = 0; term < 5; term++) {
      const runner = createCoalescingRunner({
        run: () => {
          runs++;
        },
        label: "t",
        minIntervalMs: 40,
        logger: silent,
      });
      runner.trigger();
      runner.trigger();
      runner.stop();
    }
    const afterStop = runs;
    await Bun.sleep(150);
    // Only the five leading-edge runs; every armed follow-up died with its term.
    expect(afterStop).toBe(5);
    expect(runs).toBe(5);
  });

  test("errors are logged and do not stop later runs", async () => {
    const errors: string[] = [];
    let runs = 0;
    const runner = createCoalescingRunner({
      run: async () => {
        runs++;
        throw new Error("boom");
      },
      label: "consumer",
      minIntervalMs: 0,
      logger: { error: (_fields, message) => errors.push(message) },
    });
    runner.trigger();
    await Bun.sleep(10);
    runner.trigger();
    await Bun.sleep(10);
    expect(runs).toBe(2);
    expect(errors).toEqual(["consumer: Unhandled error", "consumer: Unhandled error"]);
    runner.stop();
  });

  test("runNow bypasses the rate limit for the boot drain", async () => {
    let runs = 0;
    const runner = createCoalescingRunner({
      run: () => {
        runs++;
      },
      label: "t",
      minIntervalMs: 10_000,
      logger: silent,
    });
    runner.trigger();
    await Bun.sleep(1); // let the leading-edge run settle
    await runner.runNow();
    expect(runs).toBe(2);
    runner.stop();
  });
});

describe("session-inbox production trigger constants", () => {
  test("the real poll + watch rates keep the flush running", async () => {
    // Replays the production wiring with the production constants: a fallback
    // poll, a burst of fs.watch events, and enqueue wake signals all feeding one
    // runner. Before the redesign this combination executed zero flushes.
    let flushes = 0;
    const runner = createCoalescingRunner({
      run: async () => {
        flushes++;
        await Bun.sleep(5); // flush does real I/O
      },
      label: "session-inbox",
      minIntervalMs: SESSION_INBOX_COALESCE_MS,
      logger: silent,
    });

    const poll = setInterval(() => runner.trigger(), SESSION_INBOX_POLL_MS);
    const watchStorm = setInterval(() => runner.trigger(), 10);
    const wakeSignals = setInterval(() => runner.trigger(), 37);
    await Bun.sleep(600);
    clearInterval(poll);
    clearInterval(watchStorm);
    clearInterval(wakeSignals);
    runner.stop();

    expect(flushes).toBeGreaterThanOrEqual(4);
    expect(flushes).toBeLessThanOrEqual(9);
  });

  test("the constants are internally consistent", () => {
    // The coalescing window is now independent of the poll interval, but a poll
    // slower than the window is still what makes the poll a backstop rather
    // than the primary latency source.
    expect(SESSION_INBOX_COALESCE_MS).toBeGreaterThan(0);
    expect(SESSION_INBOX_POLL_MS).toBeGreaterThanOrEqual(SESSION_INBOX_COALESCE_MS);
    expect(SESSION_INBOX_POLL_WITHOUT_WATCH_MS).toBeLessThanOrEqual(SESSION_INBOX_POLL_MS);
    expect(SESSION_INBOX_POLL_WITHOUT_WATCH_MS).toBeGreaterThanOrEqual(SESSION_INBOX_COALESCE_MS);
  });
});
