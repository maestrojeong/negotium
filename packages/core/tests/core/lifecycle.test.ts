/**
 * Lifecycle registry coverage.
 *
 * The hand-rolled `process.once("SIGTERM", ...)` calls scattered across
 * subsystems left ordering undefined — an MCP graceful close could race
 * a subprocess kill that took its in-flight call's children out. This
 * module centralizes the registry under one signal hook; tests pin the
 * three properties that justify the refactor:
 *
 *   1. Priority is honored (highest runs first, ties keep registration order).
 *   2. A failing / hanging handler doesn't block the rest — the per-handler
 *      timeout lets the sweep continue.
 *   3. Re-trigger is a no-op (SIGINT → SIGTERM on a slow shutdown can't
 *      double-run handlers).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __handlerCount,
  __resetForTests,
  __triggered,
  onShutdown,
  runShutdown,
} from "#platform/lifecycle";

describe("lifecycle shutdown registry", () => {
  beforeEach(() => {
    __resetForTests();
  });
  afterEach(() => {
    __resetForTests();
  });

  test("handlers fire in descending priority, ties keep registration order", async () => {
    const calls: string[] = [];
    onShutdown("low-a", 10, () => {
      calls.push("low-a");
    });
    onShutdown("high", 100, () => {
      calls.push("high");
    });
    onShutdown("mid", 50, () => {
      calls.push("mid");
    });
    onShutdown("low-b", 10, () => {
      calls.push("low-b");
    });

    await runShutdown("test");
    expect(calls).toEqual(["high", "mid", "low-a", "low-b"]);
    expect(__triggered()).toBe(true);
  });

  test("a handler throwing does not block subsequent handlers", async () => {
    const calls: string[] = [];
    onShutdown("first", 100, () => {
      calls.push("first");
    });
    onShutdown("crash", 50, () => {
      throw new Error("kaboom");
    });
    onShutdown("last", 10, () => {
      calls.push("last");
    });
    await runShutdown("test");
    expect(calls).toEqual(["first", "last"]);
  });

  test("a hanging handler is capped by HANDLER_TIMEOUT_MS and the sweep continues", async () => {
    const calls: string[] = [];
    onShutdown("fast", 100, () => {
      calls.push("fast");
    });
    onShutdown("hang", 50, () => new Promise(() => {})); // never resolves
    onShutdown("after", 10, () => {
      calls.push("after");
    });
    const t0 = Date.now();
    await runShutdown("test");
    const elapsed = Date.now() - t0;
    expect(calls).toEqual(["fast", "after"]);
    // 5s handler timeout + small overhead. If the cap wasn't honored the
    // promise would never resolve and the test would time out at 5000ms,
    // so just sanity-check we didn't undershoot.
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(8_000);
  }, 10_000);

  test("re-trigger is idempotent (SIGINT-then-SIGTERM doesn't double-run)", async () => {
    let count = 0;
    onShutdown("counter", 100, () => {
      count++;
    });
    await runShutdown("test");
    await runShutdown("test");
    expect(count).toBe(1);
  });

  test("async handlers are awaited (next handler waits for prior completion)", async () => {
    const log: string[] = [];
    onShutdown("a", 100, async () => {
      log.push("a-start");
      await new Promise((r) => setTimeout(r, 50));
      log.push("a-end");
    });
    onShutdown("b", 50, () => {
      log.push("b");
    });
    await runShutdown("test");
    expect(log).toEqual(["a-start", "a-end", "b"]);
  });

  test("__resetForTests clears the registry", () => {
    onShutdown("a", 10, () => {});
    onShutdown("b", 20, () => {});
    expect(__handlerCount()).toBe(2);
    __resetForTests();
    expect(__handlerCount()).toBe(0);
    expect(__triggered()).toBe(false);
  });
});
