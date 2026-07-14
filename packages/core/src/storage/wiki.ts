import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SHARED_WIKI_DIR, WORKSPACE_DIR } from "#platform/config";
import { sanitizeTopicName } from "#security/sanitize";

export function getWikiDir(_userId: number, workspaceDir = WORKSPACE_DIR): string {
  return join(workspaceDir, "wiki");
}

/**
 * Shared wiki root. Otium keeps one workspace wiki for every topic and member;
 * filesystem wiki state is not partitioned by user.
 */
export function getSharedWikiDir(workspaceDir = WORKSPACE_DIR): string {
  return workspaceDir === WORKSPACE_DIR ? SHARED_WIKI_DIR : join(workspaceDir, "wiki");
}

/** Find the most recent wiki/summaries/ file for a given topic. */
function findLatestSummaryFile(wikiDir: string, safeTopic: string): string | null {
  const summariesDir = join(wikiDir, "summaries");
  if (!existsSync(summariesDir)) return null;
  const files = readdirSync(summariesDir)
    .filter(
      (f) =>
        f.endsWith(".md") &&
        f.match(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${safeTopic}(\\.md|-\\d+\\.md)$`)) &&
        !f.endsWith("-sent-files.md"),
    )
    .sort()
    .reverse();
  return files.length > 0 ? join(summariesDir, files[0]) : null;
}

/** Return wiki/topic/<name>.md brief path and latest summary file for system prompt injection.
 *  Falls back to forkOrigin's brief when the topic's own brief doesn't exist yet.
 *  Returns empty memoryFiles if neither brief exists. */
export function getTopicMemoryFilePaths(
  _userId: number,
  topicName: string,
  forkOrigin?: string,
  workspaceDir = WORKSPACE_DIR,
): {
  memoryDir: string;
  memoryFiles: string[];
  latestSummaryFile?: string;
  hasArchive?: boolean;
} {
  const wikiDir = getSharedWikiDir(workspaceDir);

  const resolveBrief = (name: string) => {
    const safe = sanitizeTopicName(name, true);
    const brief = join(wikiDir, "topic", `${safe}.md`);
    const latestSummary = findLatestSummaryFile(wikiDir, safe);
    return { brief, latestSummary };
  };

  const archiveDir = join(wikiDir, "archive");
  const archiveExistsFor = (name: string) => {
    const safe = sanitizeTopicName(name);
    return (
      existsSync(archiveDir) &&
      readdirSync(archiveDir).some((f) => f.endsWith(".jsonl") && f.startsWith(`${safe}_`))
    );
  };

  const sourceTopic = forkOrigin ?? topicName;
  const hasArchive =
    archiveExistsFor(sourceTopic) || (forkOrigin ? archiveExistsFor(topicName) : false);
  const target = resolveBrief(sourceTopic);
  if (existsSync(target.brief)) {
    return {
      memoryDir: dirname(target.brief),
      memoryFiles: [basename(target.brief)],
      ...(target.latestSummary ? { latestSummaryFile: target.latestSummary } : {}),
      ...(hasArchive ? { hasArchive: true } : {}),
    };
  }

  return {
    memoryDir: join(wikiDir, "topic"),
    memoryFiles: [],
    ...(target.latestSummary ? { latestSummaryFile: target.latestSummary } : {}),
    ...(hasArchive ? { hasArchive: true } : {}),
  };
}
