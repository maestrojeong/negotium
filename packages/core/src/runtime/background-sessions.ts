import { listActiveMemoryArchiverSessions } from "#agents/archiver";
import { getTopic } from "#storage/api-topics";
import { listRecentRuntimeEventsForTopic } from "#storage/runtime-events";
import { listRuntimeTurnLeases } from "#storage/runtime-leases";
import { isParticipant } from "#topics/derive";
import type { BackgroundSessionDto } from "#types/api";

const MAX_STEPS = 20;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

function cronSessionSteps(topicId: string, queryId: string): { status: string; steps: string[] } {
  let status = "Running";
  const steps: string[] = [];
  for (const event of listRecentRuntimeEventsForTopic(topicId)) {
    if (event.type !== "ai-status") continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.queryId !== queryId) continue;
    const kind = payload.kind;
    let step = "";
    if (kind === "ai_active") step = "Started scheduled turn";
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
  const cron = listRuntimeTurnLeases()
    .filter((lease) => lease.origin.startsWith("cron:"))
    .flatMap((lease): BackgroundSessionDto[] => {
      const topic = getTopic(lease.topicId);
      if (!topic || !isParticipant(topic, userId)) return [];
      const progress = cronSessionSteps(lease.topicId, lease.queryId);
      return [
        {
          id: `cron:${lease.queryId}`,
          kind: "cron",
          title: topic.title,
          topicId: topic.id,
          startedAt: new Date(lease.startedAt).toISOString(),
          status: lease.abortRequested ? "Stopping" : progress.status,
          agent: topic.agent,
          model: topic.effectiveModel ?? topic.defaultModel,
          steps: progress.steps,
        },
      ];
    });
  return [...memory, ...cron].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}
