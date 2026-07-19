import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { logger } from "#platform/logger";

export const FALLBACK_INTERVAL_MS = 5_000; // fallback poll every 5s in case fs.watch misses events

export interface OutboxWatchLogger {
  error(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface OutboxWatchHost {
  logger: OutboxWatchLogger;
}

export interface OutboxWatchOps {
  debouncedFlush(fn: () => Promise<void>, label: string, delayMs: number): () => void;
  watchDir(dir: string, onChange: () => void): FSWatcher | null;
}

export function createOutboxWatchOps(host: OutboxWatchHost): OutboxWatchOps {
  function debouncedFlush(fn: () => Promise<void>, label: string, delayMs: number) {
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
          host.logger.error({ err: e }, `${label}: Unhandled error`);
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

  function watchDir(dir: string, onChange: () => void): FSWatcher | null {
    try {
      mkdirSync(dir, { recursive: true });
      const watcher = watch(dir, { recursive: true }, () => onChange());
      watcher.on("error", (e) => {
        host.logger.warn({ err: e, dir }, "outbox: fs.watch error");
      });
      return watcher;
    } catch (e) {
      host.logger.warn({ err: e, dir }, "outbox: Failed to watch dir");
      return null;
    }
  }

  return { debouncedFlush, watchDir };
}

const defaultWatchOps = createOutboxWatchOps({ logger });

export const debouncedFlush = defaultWatchOps.debouncedFlush;
export const watchDir = defaultWatchOps.watchDir;
