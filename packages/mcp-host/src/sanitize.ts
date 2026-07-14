/**
 * Sanitize an arbitrary string for use as a single path component (port file
 * names). Mirrors core's `sanitizeFileName` (reimplemented locally so this
 * package stays standalone): everything outside [a-zA-Z0-9._-] becomes "_",
 * empty input yields "_", and pure-dot results (".", "..") are replaced with
 * "_" to block path traversal when used as a standalone component.
 */
export function sanitizePathComponent(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_") || "_";
  if (safe === "." || safe === "..") return "_";
  return safe;
}
