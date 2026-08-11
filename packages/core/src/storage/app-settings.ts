/**
 * Global (workspace-wide) application settings — a single shared record, not
 * per-user and not per-topic.
 *
 * Currently holds the global AI name (default "Otium"): one name for this
 * node. Read fresh from disk on every call, deliberately uncached — the
 * long-running node process (turn-runner, `/health`) and the short-lived
 * `negotium name` CLI process are different processes that must agree
 * immediately. A cached in-memory copy here previously meant `negotium name
 * <x>` against an already-running node silently did nothing until the node
 * was restarted. The file is tiny and this is called at most once per turn or
 * health check, so the extra read costs nothing worth caching for.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStorageDataDir } from "#storage/storage-host";

export const DEFAULT_AI_NAME = "Otium";

function settingsFile(): string {
  return join(resolveStorageDataDir(), "otium-settings.json");
}

export function getGlobalAiName(): string {
  const path = settingsFile();
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as { aiName?: unknown };
      if (typeof data.aiName === "string" && data.aiName.trim()) {
        return data.aiName.trim();
      }
    }
  } catch {
    // Corrupt/missing file → fall through to the default.
  }
  return DEFAULT_AI_NAME;
}

/** Set the global AI name (empty → reset to default). Persists to disk. */
export function setGlobalAiName(name: string): string {
  const path = settingsFile();
  const aiName = name.trim() || DEFAULT_AI_NAME;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ aiName }, null, 2));
  } catch {
    // Best-effort persistence; callers still get the resolved value back.
  }
  return aiName;
}
