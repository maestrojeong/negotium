/**
 * Exit codes and the error type of `negotium admin` (topic-link design v2 §6,
 * PR12). Every refusal is an {@link AdminError} carrying its documented exit
 * code; anything else is exit 1. Exit 9 is special: the destructive step
 * COMMITTED and only a follow-up failed — never report that as a failure.
 */

export const ADMIN_EXIT = {
  /** Report printed / dry-run plan applicable / apply committed and verified. */
  ok: 0,
  /** Unexpected error before anything was committed. */
  error: 1,
  /** Bad or missing arguments. */
  usage: 2,
  /** Refused by a safety guard; nothing was changed. */
  refused: 3,
  /** Rows changed between plan and apply; nothing was changed. */
  drift: 4,
  /** Target not found or not eligible (not a manager, not otium, …). */
  notFound: 5,
  /** The hub report is not bound to this node/epoch, stale, forged, or incomplete. */
  reportRejected: 6,
  /** APPLIED (committed), but a follow-up step failed. Look up the run id. */
  appliedFollowUpFailed: 9,
} as const;

export type AdminExitCode = (typeof ADMIN_EXIT)[keyof typeof ADMIN_EXIT];

export class AdminError extends Error {
  constructor(
    readonly exitCode: AdminExitCode,
    message: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export function refuse(message: string): never {
  throw new AdminError(ADMIN_EXIT.refused, message);
}

export function usage(message: string): never {
  throw new AdminError(ADMIN_EXIT.usage, message);
}

export function reportRejected(message: string): never {
  throw new AdminError(ADMIN_EXIT.reportRejected, message);
}

export function drift(message: string): never {
  throw new AdminError(ADMIN_EXIT.drift, message);
}

export function notFound(message: string): never {
  throw new AdminError(ADMIN_EXIT.notFound, message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
