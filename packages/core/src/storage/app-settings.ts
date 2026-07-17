/**
 * Global (workspace-wide) application settings — a single shared record, not
 * per-user and not per-topic.
 *
 * Currently holds the global AI name (default "Otium"): the AI is one named
 * entity for the whole workspace. Changing it is an admin-only action (see the
 * settings route). Loaded lazily from the currently configured storage host.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStorageDataDir } from "#storage/storage-host";

export const DEFAULT_AI_NAME = "Otium";

let aiName = DEFAULT_AI_NAME;
let loadedSettingsFile: string | null = null;

function settingsFile(): string {
  return join(resolveStorageDataDir(), "otium-settings.json");
}

function ensureSettingsLoaded(): string {
  const path = settingsFile();
  if (loadedSettingsFile === path) return path;
  loadedSettingsFile = path;
  aiName = DEFAULT_AI_NAME;
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as { aiName?: unknown };
      if (typeof data.aiName === "string" && data.aiName.trim()) {
        aiName = data.aiName.trim();
      }
    }
  } catch {
    // Corrupt/missing file → keep the default.
  }
  return path;
}

export function getGlobalAiName(): string {
  ensureSettingsLoaded();
  return aiName || DEFAULT_AI_NAME;
}

/** Set the global AI name (empty → reset to default). Persists to disk. */
export function setGlobalAiName(name: string): string {
  const path = ensureSettingsLoaded();
  aiName = name.trim() || DEFAULT_AI_NAME;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ aiName }, null, 2));
  } catch {
    // Best-effort persistence; the in-memory value still updates.
  }
  return aiName;
}
