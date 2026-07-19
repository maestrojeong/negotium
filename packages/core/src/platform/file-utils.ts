import { unlinkSync } from "node:fs";
import { logger } from "#platform/logger";

export interface SafeUnlinkHost {
  unlink(path: string): void;
  warn(context: { err: unknown; path: string }, message: string): void;
}

export type SafeUnlink = (path: string, warnLabel?: string) => void;

/** Create an isolated best-effort unlink helper using caller-owned I/O and logging. */
export function createSafeUnlink(host: SafeUnlinkHost): SafeUnlink {
  return (path, warnLabel) => {
    try {
      host.unlink(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
      if (warnLabel) host.warn({ err: e, path }, warnLabel);
    }
  };
}

const defaultSafeUnlink = createSafeUnlink({
  unlink: unlinkSync,
  warn: (context, message) => logger.warn(context, message),
});

/**
 * Best-effort unlink. ENOENT is always swallowed (the file is already gone).
 * Other errors are silent unless `warnLabel` is provided, in which case they
 * are logged at warn level with `{ err, path }` context.
 */
export function safeUnlink(path: string, warnLabel?: string): void {
  defaultSafeUnlink(path, warnLabel);
}
