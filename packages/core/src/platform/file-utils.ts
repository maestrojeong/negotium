import { unlinkSync } from "node:fs";
import { logger } from "#platform/logger";

/**
 * Best-effort unlink. ENOENT is always swallowed (the file is already gone).
 * Other errors are silent unless `warnLabel` is provided, in which case they
 * are logged at warn level with `{ err, path }` context.
 */
export function safeUnlink(path: string, warnLabel?: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
    if (warnLabel) logger.warn({ err: e, path }, warnLabel);
  }
}
