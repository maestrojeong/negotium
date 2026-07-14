/** Sanitize a topic/session name for use in file paths.
 *  Replaces non-alphanumeric characters (excluding Korean) with underscores.
 *  Empty input (or input consisting only of disallowed chars) returns "_" so
 *  callers always get a non-empty single path component.
 *  @param name  The raw topic or session name.
 *  @param lowercase  Whether to lowercase the result (default: false).
 *                    Use true for wiki paths; leave false for log file paths.
 */
export function sanitizeTopicName(name: string, lowercase = false): string {
  const safe = name.replace(/[^a-zA-Z0-9가-힣_-]/g, "_") || "_";
  return lowercase ? safe.toLowerCase() : safe;
}

/** Sanitize a file name for use in file paths. Allows dots.
 *  Pure-dot results (".", "..") are replaced with "_" to block path-traversal
 *  when the sanitized value is used as a standalone path component.
 */
export function sanitizeFileName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_") || "_";
  if (safe === "." || safe === "..") return "_";
  return safe;
}

/** Sanitize an arbitrary ID (no Korean, no dots) for use in file paths. */
export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
}
