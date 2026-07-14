import { writeFileSync } from "node:fs";
import { DEBUG_FILE } from "#platform/config";
import { readJsonFile } from "#platform/jsonl";

/** Load the set of debug-enabled user IDs from disk. Returns empty set on error. */
export function loadDebugUsers(): Set<string> {
  const arr = readJsonFile<string[]>(DEBUG_FILE);
  return new Set(arr ?? []);
}

/** Persist the debug users set to disk. */
export function saveDebugUsers(users: Set<string>): void {
  writeFileSync(DEBUG_FILE, JSON.stringify([...users], null, 2));
}
