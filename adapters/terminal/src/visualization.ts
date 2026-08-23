import { basename, extname, isAbsolute } from "node:path";

const VISUALIZE_PREFIX = "\ue200visualize\ue202";
const VISUALIZE_SUFFIX = "\ue201";
const MAX_VISUALIZATION_REFERENCE_LENGTH = 8_192;
const MAX_VISUALIZATION_PATH_LENGTH = 4_096;

export interface VisualizationReference {
  path: string;
  name: string;
  mode?: "wide";
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isSupportedVisualizationPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_VISUALIZATION_PATH_LENGTH ||
    !isAbsolute(value) ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  const extension = extname(value).toLowerCase();
  return extension === ".html" || extension === ".htm";
}

/** Parse the exact host reference without changing the persisted assistant text. */
export function parseVisualizationReference(value: string): VisualizationReference | null {
  const trimmed = value.trim();
  if (
    trimmed.length > MAX_VISUALIZATION_REFERENCE_LENGTH ||
    !trimmed.startsWith(VISUALIZE_PREFIX) ||
    !trimmed.endsWith(VISUALIZE_SUFFIX)
  ) {
    return null;
  }
  const encoded = trimmed.slice(VISUALIZE_PREFIX.length, -VISUALIZE_SUFFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length < 1 || keys.length > 2 || keys.some((key) => key !== "path" && key !== "mode")) {
    return null;
  }
  const candidate = parsed as { path?: unknown; mode?: unknown };
  if (typeof candidate.path !== "string" || !isSupportedVisualizationPath(candidate.path)) {
    return null;
  }
  if (candidate.mode !== undefined && candidate.mode !== "wide") return null;
  return {
    path: candidate.path,
    name: basename(candidate.path) || candidate.path,
    ...(candidate.mode === "wide" ? { mode: "wide" as const } : {}),
  };
}
