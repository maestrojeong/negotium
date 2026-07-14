import { logger, purgeTopicLogs, resolveTopicWorkspaceDir } from "@negotium/core";
import {
  cronTopicSessionName,
  listCronJobsForTopic,
  listCronTopicSessions,
  resetCronTopicSessions,
} from "#store";

/** Purge the shared Cron log and every provider rollout owned by one topic. */
export async function resetCronTopicContext(topicId: string): Promise<number> {
  const sessions = listCronTopicSessions(topicId);
  const owners = new Set([
    ...sessions.map((session) => session.ownerUserId),
    ...listCronJobsForTopic(topicId).map((job) => job.ownerUserId),
  ]);
  for (const ownerUserId of owners) {
    await purgeTopicLogs({
      userId: ownerUserId,
      topicName: cronTopicSessionName(topicId),
      cwd: resolveTopicWorkspaceDir(topicId),
      extraSessions: sessions
        .filter((session) => session.ownerUserId === ownerUserId)
        .map((session) => ({ agent: session.agent, sessionId: session.sessionId })),
    });
  }
  const removed = resetCronTopicSessions(topicId).length;
  logger.info({ topicId, sessions: removed, owners: owners.size }, "cron: reset topic context");
  return removed;
}
