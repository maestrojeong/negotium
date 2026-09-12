import { describe, expect, test } from "bun:test";
import { memoizeImport } from "#platform/memoize-import";

describe("memoizeImport", () => {
  test("concurrent first callers share one in-flight load instead of racing separate ones", async () => {
    let loaderCalls = 0;
    let resolveLoad: (value: { marker: string }) => void;
    const pending = new Promise<{ marker: string }>((resolve) => {
      resolveLoad = resolve;
    });
    const load = memoizeImport(() => {
      loaderCalls += 1;
      return pending;
    });

    // Two callers race before the loader has resolved — this is exactly the
    // shape of two concurrent turns dispatching to the same not-yet-loaded
    // provider. Neither `await`s before the second call starts.
    const first = load();
    const second = load();
    expect(loaderCalls).toBe(1);

    resolveLoad!({ marker: "loaded" });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a).toEqual({ marker: "loaded" });
    expect(loaderCalls).toBe(1);

    // A later call reuses the same resolved value rather than reloading.
    expect(await load()).toBe(a);
    expect(loaderCalls).toBe(1);
  });

  test("a failed load is not cached — the next call retries a fresh import", async () => {
    let loaderCalls = 0;
    const load = memoizeImport(() => {
      loaderCalls += 1;
      return loaderCalls === 1
        ? Promise.reject(new Error("transient failure"))
        : Promise.resolve({ marker: "recovered" });
    });

    await expect(load()).rejects.toThrow("transient failure");
    expect(loaderCalls).toBe(1);

    expect(await load()).toEqual({ marker: "recovered" });
    expect(loaderCalls).toBe(2);

    // The recovered value is now cached like any successful load.
    expect(await load()).toEqual({ marker: "recovered" });
    expect(loaderCalls).toBe(2);
  });

  test("concurrent callers racing a rejecting load all see the same rejection, not a partial one", async () => {
    let loaderCalls = 0;
    let rejectLoad: (err: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const load = memoizeImport(() => {
      loaderCalls += 1;
      return pending;
    });

    const first = load();
    const second = load();
    expect(loaderCalls).toBe(1);

    rejectLoad!(new Error("boom"));
    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
  });
});
