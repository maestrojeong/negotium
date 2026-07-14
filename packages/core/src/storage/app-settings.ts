/**
 * Global (workspace-wide) application settings — a single shared record, not
 * per-user and not per-topic.
 *
 * Currently holds the global AI name (default "Otium"): the AI is one named
 * entity for the whole workspace. Changing it is an admin-only action (see the
 * settings route). Loaded synchronously at import time so `getGlobalAiName()`
 * is always populated for callers like the system-prompt builder.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "#platform/config";

export const DEFAULT_AI_NAME = "Otium";

const SETTINGS_FILE = join(DATA_DIR, "otium-settings.json");

let aiName = DEFAULT_AI_NAME;

try {
  if (existsSync(SETTINGS_FILE)) {
    const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as { aiName?: unknown };
    if (typeof data.aiName === "string" && data.aiName.trim()) {
      aiName = data.aiName.trim();
    }
  }
} catch {
  // Corrupt/missing file → keep the default.
}

export function getGlobalAiName(): string {
  return aiName || DEFAULT_AI_NAME;
}

/** Set the global AI name (empty → reset to default). Persists to disk. */
export function setGlobalAiName(name: string): string {
  aiName = name.trim() || DEFAULT_AI_NAME;
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ aiName }, null, 2));
  } catch {
    // Best-effort persistence; the in-memory value still updates.
  }
  return aiName;
}
