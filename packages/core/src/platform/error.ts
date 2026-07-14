/**
 * Stringify an unknown thrown value for logging or user-visible messages.
 * Default fallback is `String(e)`. Pass an explicit fallback (e.g. "unknown")
 * to override what non-Error throws turn into.
 */
export function errMsg(e: unknown, fallback?: string): string {
  if (e instanceof Error) return e.message;
  return fallback ?? String(e);
}
