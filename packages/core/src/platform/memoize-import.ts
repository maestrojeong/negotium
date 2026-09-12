/**
 * Wraps a dynamic `import()` loader so concurrent first callers all await the
 * exact same in-flight promise instead of each racing a separate `import()`
 * call. Two callers independently calling `import()` for the same
 * not-yet-loaded specifier at once has been observed to hand the loser a
 * module namespace object whose top-level `const`s haven't finished
 * initializing yet (a `ReferenceError: Cannot access '<const>' before
 * initialization` deep inside the module) — single-flighting the load here
 * closes that race regardless of its root cause.
 *
 * A rejected load is not cached: the next call retries a fresh import rather
 * than permanently failing every future caller because of one transient
 * error.
 */
export function memoizeImport<T>(loader: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (!inFlight) {
      inFlight = loader().catch((err) => {
        inFlight = undefined;
        throw err;
      });
    }
    return inFlight;
  };
}
