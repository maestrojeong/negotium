import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { logger } from "#platform/logger";

export const FALLBACK_INTERVAL_MS = 5_000; // fallback poll every 5s in case fs.watch misses events

export function debouncedFlush(fn: () => Promise<void>, label: string, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;

  async function run(): Promise<void> {
    if (running) {
      pending = true;
      return;
    }
    while (true) {
      running = true;
      pending = false;
      try {
        await fn();
      } catch (e) {
        logger.error({ err: e }, `${label}: Unhandled error`);
      } finally {
        running = false;
      }
      if (!pending) break;
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
  };
}

export function watchDir(dir: string, onChange: () => void): FSWatcher | null {
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, { recursive: true }, () => onChange());
    watcher.on("error", (e) => {
      logger.warn({ err: e, dir }, "outbox: fs.watch error");
    });
    return watcher;
  } catch (e) {
    logger.warn({ err: e, dir }, "outbox: Failed to watch dir");
    return null;
  }
}
