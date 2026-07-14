const WIKI_SUMMARY_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export function wikiSummarySlug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9가-힣_-]+/g, "-").slice(0, 120) || "_";
}

export function isEphemeralWikiTopicId(topicId: string | undefined): boolean {
  return topicId?.startsWith("__") ?? false;
}

export function wikiSummaryStorageSlug(rawTopic: string, topicId?: string): string {
  return topicId && !isEphemeralWikiTopicId(topicId)
    ? wikiSummarySlug(topicId)
    : wikiSummarySlug(rawTopic);
}

export function wikiBriefStorageKey(rawTopic: string, topicId?: string): string {
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
