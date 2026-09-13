/**
 * Cross-platform path predicates.
 *
 * Containment checks written as `child.startsWith(`${parent}/`)` are correct on
 * POSIX and silently wrong on Windows, where `path.resolve` hands back `\`
 * separators — the comparison then rejects paths that are genuinely inside the
 * parent. Route every containment test through `isInsideDir` instead.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve for comparison, following symlinks when the path exists.
 *
 * Without the `realpath` step, macOS `/tmp/...` (a symlink to `/private/tmp`)
 * compares unequal to the same directory reached through its real name, so a
 * cwd under the system temp dir looks like an escape. Non-existent paths cannot
 * be resolved further and fall back to the lexical form, which is what callers
 * validating a path *before* creating it need.
 */
function normalizeExistingOrResolved(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  } catch {
    return resolved;
  }
}

/**
 * True when `childPath` is `parentDir` itself or lives somewhere beneath it.
 *
 * `relative()` is separator-agnostic: a path inside the parent yields a
 * relative walk that neither starts with `..` nor is absolute (the absolute
 * case is how Windows reports a different drive letter).
 */
export function isInsideDir(childPath: string, parentDir: string): boolean {
  const parent = normalizeExistingOrResolved(parentDir);
  const child = normalizeExistingOrResolved(childPath);
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Render a filesystem path with forward slashes, for logs and prompts. */
export function toDisplayPath(filePath: string): string {
  return filePath.split(sep).join("/");
}
