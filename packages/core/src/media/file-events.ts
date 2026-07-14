import { FILE_TAG_REGEX } from "#platform/config";
import type { UnifiedEvent } from "#types";

/**
 * Yield `file` events for explicit [FILE:...] tags in `text`.
 * Shared between provider implementations (claude.ts, codex.ts, maestro) so the
 * fallback tag recognition rule stays in one place.
 */
export function* extractFileEvents(text: string, source: string): Generator<UnifiedEvent> {
  const tagRegex = new RegExp(FILE_TAG_REGEX.source, "gi");
  let match: RegExpExecArray | null = tagRegex.exec(text);
  while (match !== null) {
    yield { type: "file", path: match[1], source, origin: "tag" };
    match = tagRegex.exec(text);
  }
}

/** Absolute paths referenced by explicit `[FILE:/abs/path]` tags, deduped,
 *  in order of first appearance. Channel adapters use this to send produced
 *  files alongside the text. */
export function extractFileTagPaths(text: string): string[] {
  const seen = new Set<string>();
  for (const event of extractFileEvents(text, "tag")) {
    if (event.type === "file") seen.add(event.path);
  }
  return [...seen];
}

/** Remove `[FILE:...]` tags from outbound text — the files are delivered as
 *  real attachments by the channel, so the raw tags are just noise. */
export function stripFileTags(text: string): string {
  return text.replace(new RegExp(FILE_TAG_REGEX.source, "gi"), "").trim();
}
