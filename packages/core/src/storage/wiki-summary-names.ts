const WIKI_SUMMARY_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

export function wikiSummarySlug(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9가-힣_-]+/g, "-").slice(0, 120) || "_";
}

/**
 * Wiki memory is a title-keyed namespace. Reopening or recreating a room with
 * the same title must continue the same accumulated topic memory.
 */
export function wikiSummaryStorageSlug(rawTopic: string, _topicId?: string): string {
  return wikiSummarySlug(rawTopic);
}

/**
 * Resolve the canonical filename key for a topic brief.
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
  topicTitle?: string,
): boolean {
  if (!WIKI_SUMMARY_DATE_PREFIX.test(filename)) return false;
  if (topicTitle) {
    const titleSlug = wikiSummarySlug(topicTitle);
    if (
      new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escapeRegExp(titleSlug)}(?:~\\d+)?\\.md$`).test(filename)
    ) {
      return true;
    }
  }
  const idSlug = wikiSummarySlug(topicId);
  return filename.endsWith(`--${idSlug}.md`) || filename.endsWith(`-${idSlug}.md`);
}

export function isTopicBriefFile(filename: string, topicId: string, topicTitle?: string): boolean {
  if (topicTitle && filename === `${wikiSummarySlug(topicTitle)}.md`) return true;
  const idSlug = wikiSummarySlug(topicId);
  return filename === `${idSlug}.md` || filename.endsWith(`--${idSlug}.md`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
