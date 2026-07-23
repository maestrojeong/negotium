const WIKI_SUMMARY_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export function wikiSummarySlug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9가-힣_-]+/g, "-").slice(0, 120) || "_";
}

export function isEphemeralWikiTopicId(topicId: string | undefined): boolean {
  return topicId?.startsWith("__") ?? false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns true when the given string is just a raw UUID with no human-readable
 * title component — typically cron/spawn topics that were never given a name.
 */
function isBareUuidTopic(rawTopic: string): boolean {
  return UUID_RE.test(rawTopic);
}

/**
 * Resolve the canonical storage slug for a topic summary file. Prefers the
 * human-readable topic title so wiki files are named after their topic rather
 * than an opaque UUID. Falls back to UUID only for bare-UUID topics (cron,
 * spawn) that have no readable title.
 */
export function wikiSummaryStorageSlug(rawTopic: string, topicId?: string): string {
  if (!isBareUuidTopic(rawTopic)) return wikiSummarySlug(rawTopic);
  return topicId && !isEphemeralWikiTopicId(topicId)
    ? wikiSummarySlug(topicId)
    : wikiSummarySlug(rawTopic);
}

/**
 * Resolve the canonical storage key for a topic brief. Prefers the
 * human-readable topic title as the DB key; only bare-UUID topics use their
 * raw UUID, and ephemeral archiver sessions fall through to the title.
 */
export function wikiBriefStorageKey(rawTopic: string, topicId?: string): string {
  if (!isBareUuidTopic(rawTopic)) return rawTopic;
  return topicId && !isEphemeralWikiTopicId(topicId) ? topicId : rawTopic;
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
  if (filename.endsWith(`-${wikiSummarySlug(topicId)}.md`)) return true;
  return legacyTopicTitle ? filename.endsWith(`-${wikiSummarySlug(legacyTopicTitle)}.md`) : false;
}
