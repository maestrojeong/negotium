/**
 * `@`-triggered filesystem path completion for the terminal composer.
 *
 * Typing `@` (optionally followed by a path fragment) offers suggestions drawn
 * from the *real* filesystem, rooted at the user's home directory by default.
 * `@~/…`, `@/abs/…`, and bare `@name` (relative to home) are all supported.
 * The list is capped so a large directory never floods the composer.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface PathSuggestion {
  /** Row label — basename with a trailing `/` for directories. */
  label: string;
  /** Replacement token including the leading `@` (e.g. `@~/Documents/`). */
  value: string;
  isDir: boolean;
}

export interface PathSuggestResult {
  /** Column (0-based) of the `@` that starts the active token on its line. */
  start: number;
  /** Column just past the fragment (where the cursor sits). */
  end: number;
  items: PathSuggestion[];
  /** Count of matches beyond `items` that were trimmed off. */
  truncated: number;
}

const MAX_SUGGESTIONS = 8;

/** Locate an active `@…` token that ends at `col` on a single input line. */
export function activeAtToken(
  lineText: string,
  col: number,
): { start: number; frag: string } | null {
  const upto = lineText.slice(0, col);
  // Token = trailing run of non-space chars, must be preceded by start/space.
  const match = /(?:^|\s)@([^\s]*)$/.exec(upto);
  if (!match) return null;
  const frag = match[1] ?? "";
  return { start: col - frag.length - 1, frag };
}

/** Resolve a fragment (text after `@`) to the directory to list + name prefix. */
function resolveFragment(frag: string): { dir: string; prefix: string } {
  const home = homedir();
  let path: string;
  if (frag === "" || frag === "~") path = home;
  else if (frag === "~/") path = home;
  else if (frag.startsWith("~/")) path = join(home, frag.slice(2));
  else if (frag.startsWith("/")) path = frag;
  else path = join(home, frag); // bare `@name` → relative to home

  // A trailing slash means "list this directory"; otherwise the last segment
  // is a prefix to match within its parent.
  if (frag.endsWith("/") || frag === "" || frag === "~") {
    return { dir: path, prefix: "" };
  }
  return { dir: dirname(path), prefix: basename(path) };
}

/** Render an absolute path back into the composer, preferring `~` under home. */
function toToken(fullPath: string, isDir: boolean): string {
  const home = homedir();
  let shown = fullPath;
  if (fullPath === home) shown = "~";
  else if (fullPath.startsWith(`${home}/`)) shown = `~/${fullPath.slice(home.length + 1)}`;
  return `@${shown}${isDir ? "/" : ""}`;
}

/** Compute `@`-path suggestions for the cursor position, or null if inactive. */
export function pathSuggestions(lineText: string, col: number): PathSuggestResult | null {
  const token = activeAtToken(lineText, col);
  if (!token) return null;
  const { dir, prefix } = resolveFragment(token.frag);

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { start: token.start, end: col, items: [], truncated: 0 };
  }

  const lowerPrefix = prefix.toLowerCase();
  const showHidden = prefix.startsWith(".");
  const matched = entries
    .filter((entry) => {
      const name = entry.name;
      if (!showHidden && name.startsWith(".")) return false;
      return name.toLowerCase().startsWith(lowerPrefix);
    })
    .map((entry) => {
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, entry.name)).isDirectory();
        } catch {
          // Broken symlink / permission race: treat it as a file.
        }
      }
      return { name: entry.name, isDir };
    })
    // Directories first, then case-insensitive name order.
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const items: PathSuggestion[] = matched.slice(0, MAX_SUGGESTIONS).map(({ name, isDir }) => ({
    label: `${name}${isDir ? "/" : ""}`,
    value: toToken(join(dir, name), isDir),
    isDir,
  }));

  return {
    start: token.start,
    end: col,
    items,
    truncated: Math.max(0, matched.length - items.length),
  };
}

/**
 * Replace the active `@` token on `lineText` with `suggestion`. Directory
 * suggestions keep the cursor right after the trailing `/` so the user can
 * immediately keep drilling; file suggestions leave the cursor at the end.
 */
export function completePathToken(
  lineText: string,
  col: number,
  suggestion: PathSuggestion,
  options: { keepTrigger?: boolean } = {},
): { line: string; col: number } | null {
  const token = activeAtToken(lineText, col);
  if (!token) return null;
  const replacement = options.keepTrigger ? suggestion.value : suggestion.value.slice(1);
  const line = lineText.slice(0, token.start) + replacement + lineText.slice(col);
  return { line, col: token.start + replacement.length };
}
