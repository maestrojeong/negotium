import { listActiveMemoryArchiverSessions } from "#agents/archiver";
import { getTopic } from "#storage/api-topics";
import { listRecentRuntimeEventsForTopic } from "#storage/runtime-events";
import { listRuntimeTurnLeases } from "#storage/runtime-leases";
import { isParticipant } from "#topics/derive";
import type { BackgroundSessionDto } from "#types/api";

const MAX_STEPS = 20;
export type BackgroundSessionProvider = (userId: string) => BackgroundSessionDto[];

const providers = new Set<BackgroundSessionProvider>();

export function registerBackgroundSessionProvider(provider: BackgroundSessionProvider): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

export function backgroundSessionProgress(
  topicId: string,
  queryId: string,
): { status: string; steps: string[] } {
  let status = "Running";
  const steps: string[] = [];
  for (const event of listRecentRuntimeEventsForTopic(topicId)) {
    if (event.type !== "ai-status") continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.queryId !== queryId) continue;
    const kind = payload.kind;
    let step = "";
    if (kind === "ai_active") step = "Started scheduled turn";
    else if (kind === "reasoning") step = `Reasoning: ${text(payload.content)}`;
    else if (kind === "tool_call") step = text(payload.label) || `Tool: ${text(payload.name)}`;
    else if (kind === "tool_status") step = text(payload.content);
    else if (kind === "tool_output") step = "Tool completed";
    else if (kind === "ai_error") step = "Scheduled turn failed";
    else if (kind === "ai_aborted") step = "Scheduled turn stopped";
    if (step && steps.at(-1) !== step) steps.push(step);
    if (step) status = step;
  }
  return { status, steps: steps.slice(-MAX_STEPS) };
}

export function listBackgroundSessionsForUser(userId: string): BackgroundSessionDto[] {
  const memory = listActiveMemoryArchiverSessions(userId);
  const provided = [...providers].flatMap((provider) => provider(userId));
  const providedCronTopicIds = new Set(
    provided
      .filter((session) => session.kind === "cron")
      .map((session) => session.topicId)
      .filter((topicId): topicId is string => Boolean(topicId)),
  );
  const cron = listRuntimeTurnLeases()
    .filter((lease) => lease.origin.startsWith("cron:"))
    .flatMap((lease): BackgroundSessionDto[] => {
      const topic = getTopic(lease.topicId);
      if (!topic || !isParticipant(topic, userId) || providedCronTopicIds.has(lease.topicId)) {
        return [];
      }
      const progress = backgroundSessionProgress(lease.topicId, lease.queryId);
      return [
        {
          id: `cron:${lease.queryId}`,
          kind: "cron",
          title: topic.title,
          topicId: topic.id,
          startedAt: new Date(lease.startedAt).toISOString(),
          status: lease.abortRequested ? "Stopping" : progress.status,
          active: true,
          agent: topic.agent,
          model: topic.effectiveModel ?? topic.defaultModel,
          effort: topic.effectiveEffort ?? topic.defaultEffort,
          steps: progress.steps,
        },
      ];
    });
  return [...memory, ...provided, ...cron].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}
