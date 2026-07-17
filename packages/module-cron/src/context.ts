import { logger } from "@negotium/core";
import { cronHost } from "#host";
import {
  type CronJobPatch,
  type CronJobRecord,
  cronJobPatchChangesContext,
  cronTopicSessionName,
  getCronJob,
  listCronJobsForTopic,
  listCronTopicSessions,
  markCronTopicContextRotated,
  resetCronTopicContextState,
  resetCronTopicSessions,
  updateCronJob,
} from "#store";

export const CRON_CONTEXT_ROTATE_EVERY = 5;
export const CRON_CONTEXT_RETAIN_TURNS = 5;

/** Update one job and fully discard shared history affected by runtime/source changes. */
export async function updateCronJobWithContextReset(
  id: string,
  patch: CronJobPatch,
  now = new Date(),
): Promise<CronJobRecord | null> {
  const previous = getCronJob(id);
  if (!previous) return null;
  const resetRequired = cronJobPatchChangesContext(previous, patch);
  const updated = updateCronJob(id, patch, now);
  if (!updated || !resetRequired) return updated;

  await resetCronTopicContext(previous.topicId, [previous.ownerUserId]);
  if (updated.topicId !== previous.topicId) {
    await resetCronTopicContext(updated.topicId, [updated.ownerUserId]);
  }
  return getCronJob(id);
}

/** Purge the shared Cron log and every provider rollout owned by one topic. */
export async function resetCronTopicContext(
  topicId: string,
  extraOwnerUserIds: Iterable<string> = [],
): Promise<number> {
  const host = cronHost();
  const sessions = listCronTopicSessions(topicId);
  const owners = new Set([
    ...sessions.map((session) => session.ownerUserId),
    ...listCronJobsForTopic(topicId).map((job) => job.ownerUserId),
    ...extraOwnerUserIds,
  ]);
  for (const ownerUserId of owners) {
    await host.purgeTopicLogs({
      userId: ownerUserId,
      topicName: cronTopicSessionName(topicId),
      cwd: host.resolveTopicWorkspaceDir(topicId),
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
  const host = cronHost();
  const sessions = listCronTopicSessions(topicId);
  const jobs = listCronJobsForTopic(topicId);
  const owners = new Set([
    ...sessions.map((session) => session.ownerUserId),
    ...jobs.map((job) => job.ownerUserId),
  ]);
  let totalTurns = 0;
  let retained = 0;

  for (const ownerUserId of owners) {
    const result = await host.rotateTopicLogs({
      userId: ownerUserId,
      topicName: cronTopicSessionName(topicId),
      cwd: host.resolveTopicWorkspaceDir(topicId),
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
