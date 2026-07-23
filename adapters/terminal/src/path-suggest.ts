/**
 * `@`-triggered filesystem path completion for the terminal composer.
 *
 * Typing `@` (optionally followed by a path fragment) offers suggestions drawn
 * from the *real* filesystem, rooted at the user's home directory by default.
 * `@~/…`, `@/abs/…`, and bare `@name` (relative to home) are all supported.
 * The list is capped so a large directory never floods the composer.
 */

import { execFile } from "node:child_process";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";

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
  /** Whether a recursive filesystem index is currently loading. */
  searching: boolean;
}

const MAX_SUGGESTIONS = 8;

// Below this fragment length, only the current directory is listed (cheap,
// synchronous readdir). At or above it, we additionally shell out to
// ripgrep for a recursive, substring search rooted at the same directory —
// short fragments would otherwise return far too many recursive matches to
// be useful, and would make every keystroke spawn a subprocess.
const RECURSIVE_MIN_PREFIX_LEN = 4;
const RECURSIVE_MAX_DEPTH = 10;
// A full walk from $HOME can take over a second on a well-populated machine
// (hundreds of thousands of entries even after excludes), so this needs
// real headroom — a short timeout silently discards a slow-but-valid scan.
const RECURSIVE_TIMEOUT_MS = 2_000;
const RECURSIVE_CACHE_TTL_MS = 30_000;
const MAX_RECURSIVE_CACHE_ENTRIES = 3;
const MAX_MATCH_CACHE_ENTRIES = 24;
const RECURSIVE_EXCLUDES = ["node_modules", ".git", ".cache", "dist", "build", "Library", ".Trash"];

interface RecursiveCacheEntry {
  loadedAt: number;
  paths: IndexedRecursivePath[];
  matches: Map<string, Candidate[]>;
}

interface IndexedRecursivePath {
  relPath: string;
  isDir: boolean;
  lowerName: string;
}

const recursiveCache = new Map<string, RecursiveCacheEntry>();
const recursiveSearches = new Map<string, Promise<boolean>>();
const execFileAsync = promisify(execFile);

export type RecursivePathLoader = (dir: string) => Promise<string[]>;

function indexRecursivePaths(files: string[]): IndexedRecursivePath[] {
  const paths: IndexedRecursivePath[] = [];
  const directories = new Set<string>();
  for (const relPath of files) {
    const segments = relPath.split("/");
    if (segments.some((segment) => segment.startsWith("."))) continue;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const directory = segments.slice(0, index + 1).join("/");
      if (directories.has(directory)) continue;
      directories.add(directory);
      paths.push({
        relPath: directory,
        isDir: true,
        lowerName: (segments[index] ?? "").toLowerCase(),
      });
    }
    paths.push({ relPath, isDir: false, lowerName: (segments.at(-1) ?? "").toLowerCase() });
  }
  return paths;
}

async function listFilesWithRipgrep(dir: string): Promise<string[]> {
  const args = ["--files", "--max-depth", String(RECURSIVE_MAX_DEPTH)];
  for (const excluded of RECURSIVE_EXCLUDES) args.push("-g", `!${excluded}`);
  args.push(".");

  let out = "";
  try {
    const result = await execFileAsync("rg", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: RECURSIVE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    out = result.stdout;
  } catch (err) {
    // Permission errors make rg exit non-zero, but readable paths are still
    // useful. ENOENT and a timeout simply leave the current-directory list.
    const stdout = (err as { stdout?: unknown } | null)?.stdout;
    out = typeof stdout === "string" ? stdout : "";
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((path) => path.replaceAll(sep, "/").replace(/^\.\//, ""));
}

function cacheRecursivePaths(dir: string, files: string[]): void {
  const now = Date.now();
  for (const [key, entry] of recursiveCache) {
    if (now - entry.loadedAt >= RECURSIVE_CACHE_TTL_MS) recursiveCache.delete(key);
  }
  recursiveCache.delete(dir);
  while (recursiveCache.size >= MAX_RECURSIVE_CACHE_ENTRIES) {
    const oldest = recursiveCache.keys().next().value;
    if (oldest === undefined) break;
    recursiveCache.delete(oldest);
  }
  recursiveCache.set(dir, {
    loadedAt: now,
    paths: indexRecursivePaths(files),
    matches: new Map(),
  });
}

/** Populate the recursive file index without blocking terminal input or rendering. */
function loadFilesRecursive(dir: string, loader: RecursivePathLoader): Promise<boolean> {
  const cached = recursiveCache.get(dir);
  if (cached && Date.now() - cached.loadedAt < RECURSIVE_CACHE_TTL_MS) {
    recursiveCache.delete(dir);
    recursiveCache.set(dir, cached);
    return Promise.resolve(false);
  }
  const active = recursiveSearches.get(dir);
  if (active) return active;

  const search = (async () => {
    try {
      cacheRecursivePaths(dir, await loader(dir));
    } catch {
      cacheRecursivePaths(dir, []);
    }
    return true;
  })().finally(() => recursiveSearches.delete(dir));
  recursiveSearches.set(dir, search);
  return search;
}

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

interface Candidate {
  /** Path relative to `dir`, "/"-separated (may include subdirectories). */
  relPath: string;
  isDir: boolean;
  isPrefixMatch: boolean;
}

function rankAndSlice(dir: string, candidates: Candidate[]): PathSuggestResult["items"] {
  candidates.sort((a, b) => {
    if (a.isPrefixMatch !== b.isPrefixMatch) return a.isPrefixMatch ? -1 : 1;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const depthA = a.relPath.split("/").length;
    const depthB = b.relPath.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.relPath.localeCompare(b.relPath);
  });
  return candidates.slice(0, MAX_SUGGESTIONS).map(({ relPath, isDir }) => ({
    label: `${relPath}${isDir ? "/" : ""}`,
    value: toToken(join(dir, relPath), isDir),
    isDir,
  }));
}

function recursiveCandidates(dir: string, lowerPrefix: string, seen: Set<string>): Candidate[] {
  const entry = recursiveCache.get(dir);
  if (!entry) return [];
  let matches = entry.matches.get(lowerPrefix);
  if (!matches) {
    matches = entry.paths
      .filter((path) => path.lowerName.includes(lowerPrefix))
      .map((path) => ({
        relPath: path.relPath,
        isDir: path.isDir,
        isPrefixMatch: path.lowerName.startsWith(lowerPrefix),
      }));
    if (entry.matches.size >= MAX_MATCH_CACHE_ENTRIES) {
      const oldest = entry.matches.keys().next().value;
      if (oldest !== undefined) entry.matches.delete(oldest);
    }
    entry.matches.set(lowerPrefix, matches);
  } else {
    entry.matches.delete(lowerPrefix);
    entry.matches.set(lowerPrefix, matches);
  }
  return matches.filter((candidate) => {
    if (seen.has(candidate.relPath)) return false;
    seen.add(candidate.relPath);
    return true;
  });
}

/** Whether the cursor has a path query specific enough for recursive search. */
export function isRecursivePathQuery(lineText: string, col: number): boolean {
  const token = activeAtToken(lineText, col);
  if (!token) return false;
  const { prefix } = resolveFragment(token.frag);
  return !prefix.startsWith(".") && prefix.length >= RECURSIVE_MIN_PREFIX_LEN;
}

/** Warm recursive suggestions after the composer's input debounce. */
export async function warmPathSuggestions(
  lineText: string,
  col: number,
  loader: RecursivePathLoader = listFilesWithRipgrep,
): Promise<boolean> {
  if (!isRecursivePathQuery(lineText, col)) return false;
  const token = activeAtToken(lineText, col);
  if (!token) return false;
  const { dir } = resolveFragment(token.frag);
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return loadFilesRecursive(dir, loader);
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
    return { start: token.start, end: col, items: [], truncated: 0, searching: false };
  }

  const lowerPrefix = prefix.toLowerCase();
  const showHidden = prefix.startsWith(".");

  const candidates: Candidate[] = entries
    .filter((entry) => {
      const name = entry.name;
      if (!showHidden && name.startsWith(".")) return false;
      if (lowerPrefix === "") return true;
      // Dotfile browsing (`@.`) stays prefix-based; everything else is fuzzy.
      const lowerName = name.toLowerCase();
      return showHidden ? lowerName.startsWith(lowerPrefix) : lowerName.includes(lowerPrefix);
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
      return {
        relPath: entry.name,
        isDir,
        isPrefixMatch: entry.name.toLowerCase().startsWith(lowerPrefix),
      };
    });

  // Fuzzy-recursive search: once the fragment is long enough to be
  // meaningfully specific, also pull in matches from subdirectories so
  // `@config` finds `src/app/config.ts` without needing `@src/app/config`.
  if (!showHidden && lowerPrefix.length >= RECURSIVE_MIN_PREFIX_LEN) {
    const seen = new Set(candidates.map((c) => c.relPath));
    candidates.push(...recursiveCandidates(dir, lowerPrefix, seen));
  }

  const items = rankAndSlice(dir, candidates);
  return {
    start: token.start,
    end: col,
    items,
    truncated: Math.max(0, candidates.length - items.length),
    searching: recursiveSearches.has(dir),
  };
}

/** Resolve a fragment (text after `@`) to an absolute path, mirroring `resolveFragment`. */
function fragmentToAbsolutePath(frag: string): string {
  const home = homedir();
  if (frag === "~" || frag === "~/") return home;
  if (frag.startsWith("~/")) return join(home, frag.slice(2));
  if (frag.startsWith("/")) return frag;
  return join(home, frag);
}

// A submitted `@path` token may also sit immediately inside opening punctuation,
// e.g. `(@~/notes.md)`. Keep the opening delimiter in the replacement.
const AT_PATH_TOKEN = /(^|[\s([{<])@([^\s]+)/g;

// Trailing sentence/enclosing punctuation that is almost never part of a real
// path in prose, e.g. `see @~/notes.md.` or `(@~/dir)`. Stripped off before the
// existence check, then preserved in the output.
const TRAILING_PUNCT = /[.,;:!?)\]}>"'`]+$/;

function fragmentResolves(frag: string): boolean {
  try {
    return existsSync(fragmentToAbsolutePath(frag));
  } catch {
    return false;
  }
}

/**
 * Strip the leading `@` from every `@path` token whose target actually exists
 * on disk, leaving `@mentions` and other non-path `@` tokens untouched. Called
 * at submit time so referenced paths are delivered clean while the `@` trigger
 * stays live during composition (letting the user re-search by returning to it).
 *
 * Trailing punctuation is tolerated: `@~/a.txt,` strips the `@` and keeps the
 * comma. The full fragment is tried first, so a path that genuinely ends in a
 * punctuation char is still matched as-is.
 */
export function stripResolvedPathTriggers(text: string): string {
  return text.replaceAll(AT_PATH_TOKEN, (whole, lead: string, frag: string) => {
    if (fragmentResolves(frag)) return `${lead}${frag}`;
    const pathPart = frag.replace(TRAILING_PUNCT, "");
    if (pathPart && pathPart !== frag && fragmentResolves(pathPart)) {
      return `${lead}${pathPart}${frag.slice(pathPart.length)}`;
    }
    return whole;
  });
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
  // Completing from inside an already-typed token: extend past the non-space
  // chars after the cursor so the whole token is replaced. Otherwise the tail
  // survives and the path is duplicated (e.g. `@/tmp/alp|ha/x` → `…/alpha/ha/x`).
  let end = col;
  while (end < lineText.length && !/\s/.test(lineText[end] ?? " ")) end += 1;
  const replacement = options.keepTrigger ? suggestion.value : suggestion.value.slice(1);
  const line = lineText.slice(0, token.start) + replacement + lineText.slice(end);
  return { line, col: token.start + replacement.length };
}
