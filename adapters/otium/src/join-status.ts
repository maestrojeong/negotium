import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "@negotium/core/config";

/** Cheap preflight used before importing the Otium runtime graph. */
export function hasConfiguredOtiumJoin(): boolean {
  const envJoin = Boolean(
    process.env.OTIUM_CENTRAL_URL?.trim() &&
      process.env.OTIUM_CELL_ID?.trim() &&
      process.env.OTIUM_CELL_SECRET?.trim(),
  );
  return envJoin || existsSync(resolve(DATA_DIR, "otium-join.json"));
}
