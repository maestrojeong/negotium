import {
  type BackgroundSessionDto,
  backgroundSessionProgress,
  getTopic,
  isParticipant,
  listRuntimeTurnLeases,
} from "@negotium/core";
import type { CronJobRecord, CronRunRecord } from "#store";
import { getLastCronRun, listCronJobs } from "#store";

interface DisplayRun {
  job: CronJobRecord;
  run: CronRunRecord;
}

function promptForJob(job: CronJobRecord): string {
  return job.prompt ?? `Script: ${job.script ?? "unknown"}`;
}

function latestRun(jobs: CronJobRecord[]): DisplayRun | undefined {
  return jobs
    .flatMap((job): DisplayRun[] => {
      const run = getLastCronRun(job.id);
      return run ? [{ job, run }] : [];
    })
    .sort((left, right) => right.run.scheduledAt.localeCompare(left.run.scheduledAt))[0];
}

export function listCronBackgroundSessions(userId: string): BackgroundSessionDto[] {
  const jobsByTopic = new Map<string, CronJobRecord[]>();
  for (const job of listCronJobs()) {
    const topic = getTopic(job.topicId);
    if (!topic || !isParticipant(topic, userId)) continue;
    const jobs = jobsByTopic.get(job.topicId) ?? [];
    jobs.push(job);
    jobsByTopic.set(job.topicId, jobs);
  }

  const cronLeases = listRuntimeTurnLeases().filter((lease) => lease.origin.startsWith("cron:"));
  return [...jobsByTopic].flatMap(([topicId, jobs]): BackgroundSessionDto[] => {
    const topic = getTopic(topicId);
    if (!topic) return [];
    const lease = cronLeases.find((candidate) => candidate.topicId === topicId);
    const activeJobId = lease?.origin.split(":")[1];
    const recent = latestRun(jobs);
    const displayJob =
      jobs.find((job) => job.id === activeJobId) ??
      (recent?.job.id ? jobs.find((job) => job.id === recent.job.id) : undefined) ??
      jobs[0];
    if (!displayJob) return [];

    const queryId = lease?.queryId ?? recent?.run.queryId;
    const progress = queryId ? backgroundSessionProgress(topicId, queryId) : undefined;
    const enabledJobs = jobs.filter((job) => job.enabled);
    const nextJob = [...enabledJobs].sort((left, right) =>
      left.nextRunAt.localeCompare(right.nextRunAt),
    )[0];
    const steps = progress?.steps.length
      ? progress.steps
      : [
          ...(recent ? [`Last run: ${recent.job.name} · ${recent.run.status}`] : ["No runs yet"]),
          ...(nextJob ? [`Next: ${nextJob.name} · ${nextJob.nextRunAt}`] : []),
        ];

    return [
      {
        id: `cron:${topicId}`,
        kind: "cron",
        title: topic.title,
        topicId,
        startedAt:
          (lease ? new Date(lease.startedAt).toISOString() : recent?.run.startedAt) ??
          displayJob.createdAt,
        status: lease
          ? lease.abortRequested
            ? "Stopping"
            : (progress?.status ?? "Running")
          : enabledJobs.length > 0
            ? "Scheduled"
            : "Paused",
        active: Boolean(lease),
        agent: displayJob.agent ?? topic.agent,
        model: displayJob.model ?? topic.effectiveModel ?? topic.defaultModel,
        effort: displayJob.effort ?? topic.effectiveEffort ?? topic.defaultEffort,
        prompt: promptForJob(displayJob),
        promptTitle: `Prompt · ${displayJob.name}`,
        steps,
      },
    ];
  });
}
