import { logger, purgeTopicLogs, resolveTopicWorkspaceDir, rotateTopicLogs } from "@negotium/core";
import {
  cronTopicSessionName,
  listCronJobsForTopic,
  listCronTopicSessions,
  markCronTopicContextRotated,
  resetCronTopicContextState,
  resetCronTopicSessions,
} from "#store";

export const CRON_CONTEXT_ROTATE_EVERY = 5;
export const CRON_CONTEXT_RETAIN_TURNS = 5;

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
  resetCronTopicContextState(topicId);
  logger.info({ topicId, sessions: removed, owners: owners.size }, "cron: reset topic context");
  return removed;
}

export interface CronTopicRotationResult {
  rotated: boolean;
  clearedProviderSessions: number;
  totalTurns: number;
  retainedTurns: number;
}

/** Rotate provider sessions while carrying a bounded tail into the next run. */
export async function rotateCronTopicContext(
  topicId: string,
  retainTurns = CRON_CONTEXT_RETAIN_TURNS,
): Promise<CronTopicRotationResult> {
  const sessions = listCronTopicSessions(topicId);
  const jobs = listCronJobsForTopic(topicId);
  const owners = new Set([
    ...sessions.map((session) => session.ownerUserId),
    ...jobs.map((job) => job.ownerUserId),
  ]);
  let totalTurns = 0;
  let retained = 0;

  for (const ownerUserId of owners) {
    const result = await rotateTopicLogs({
      userId: ownerUserId,
      topicName: cronTopicSessionName(topicId),
      cwd: resolveTopicWorkspaceDir(topicId),
      retainTurns,
      extraSessions: sessions
        .filter((session) => session.ownerUserId === ownerUserId)
        .map((session) => ({ agent: session.agent, sessionId: session.sessionId })),
    });
    if (!result.rotated) {
      return {
        rotated: false,
        clearedProviderSessions: 0,
        totalTurns: result.totalTurns,
        retainedTurns: result.retainedTurns,
      };
    }
    totalTurns = Math.max(totalTurns, result.totalTurns);
    retained = Math.max(retained, result.retainedTurns);
  }

  const clearedProviderSessions = resetCronTopicSessions(topicId).length;
  markCronTopicContextRotated(topicId);
  logger.info(
    { topicId, clearedProviderSessions, totalTurns, retainedTurns: retained },
    "cron: rotated bounded topic context",
  );
  return {
    rotated: true,
    clearedProviderSessions,
    totalTurns,
    retainedTurns: retained,
  };
}
