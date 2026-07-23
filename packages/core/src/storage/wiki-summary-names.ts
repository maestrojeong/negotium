const WIKI_SUMMARY_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export function wikiSummarySlug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9가-힣_-]+/g, "-").slice(0, 120) || "_";
}

export function isEphemeralWikiTopicId(topicId: string | undefined): boolean {
  return topicId?.startsWith("__") ?? false;
}

/**
 * Resolve a readable, collision-safe storage slug. Stable topic ids remain in
 * the suffix so equal titles and slug collisions cannot overwrite each other.
 */
export function wikiSummaryStorageSlug(rawTopic: string, topicId?: string): string {
  const titleSlug = wikiSummarySlug(rawTopic);
  if (!topicId || isEphemeralWikiTopicId(topicId)) return titleSlug;
  const idSlug = wikiSummarySlug(topicId);
  return titleSlug === idSlug ? idSlug : `${titleSlug}--${idSlug}`;
}

/**
 * Resolve the canonical filename key for a topic brief mirror. SQLite remains
 * keyed by the full topic id; the title prefix only makes the mirror readable.
 */
export function wikiBriefStorageKey(rawTopic: string, topicId?: string): string {
  return wikiSummaryStorageSlug(rawTopic, topicId);
}

export function wikiSummaryFilename(date: string, rawTopic: string, topicId?: string): string {
  return `${date}-${wikiSummaryStorageSlug(rawTopic, topicId)}.md`;
}

export function isTopicSummaryFile(
  filename: string,
  topicId: string,
  legacyTopicTitle?: string,
): boolean {
  if (!WIKI_SUMMARY_DATE_PREFIX.test(filename)) return false;
  const idSlug = wikiSummarySlug(topicId);
  if (filename.endsWith(`--${idSlug}.md`) || filename.endsWith(`-${idSlug}.md`)) return true;
  return legacyTopicTitle ? filename.endsWith(`-${wikiSummarySlug(legacyTopicTitle)}.md`) : false;
}

export function isTopicBriefFile(
  filename: string,
  topicId: string,
  legacyTopicTitle?: string,
): boolean {
  const idSlug = wikiSummarySlug(topicId);
  if (filename === `${idSlug}.md` || filename.endsWith(`--${idSlug}.md`)) return true;
  return legacyTopicTitle ? filename === `${wikiSummarySlug(legacyTopicTitle)}.md` : false;
}
