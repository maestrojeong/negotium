import { logger } from "#platform/logger";
import { onPlaywrightFailure, type PlaywrightFailure } from "#platform/playwright/manager";
import { AbortReason } from "#query/types";

export interface PlaywrightTurnControl {
  topicId: string;
  queryId: string;
  abortController: AbortController;
  abortReason: AbortReason;
  abortError?: string;
}

const turnsByInstance = new Map<string, Set<PlaywrightTurnControl>>();

export function trackPlaywrightTurn(instanceKey: string, control: PlaywrightTurnControl): void {
  const turns = turnsByInstance.get(instanceKey) ?? new Set<PlaywrightTurnControl>();
  turns.add(control);
  turnsByInstance.set(instanceKey, turns);
}

export function untrackPlaywrightTurn(instanceKey: string, control: PlaywrightTurnControl): void {
  const turns = turnsByInstance.get(instanceKey);
  if (!turns) return;
  turns.delete(control);
  if (turns.size === 0) turnsByInstance.delete(instanceKey);
}

function failureMessage(failure: PlaywrightFailure): string {
  if (failure.reason === "unhealthy") {
    return "Browser MCP transport became unresponsive and was restarted";
  }
  if (failure.reason === "process-error") {
    return `Browser MCP process failed${failure.error ? `: ${failure.error}` : ""}`;
  }
  return (
    "Browser MCP exited unexpectedly" +
    (failure.code === null || failure.code === undefined ? "" : ` (exitCode=${failure.code})`)
  );
}

export function abortPlaywrightTurns(instanceKey: string, failure: PlaywrightFailure): number {
  const turns = turnsByInstance.get(instanceKey);
  if (!turns) return 0;

  const error = failureMessage(failure);
  let aborted = 0;
  for (const control of turns) {
    if (control.abortController.signal.aborted) continue;
    control.abortReason = AbortReason.Infrastructure;
    control.abortError = error;
    control.abortController.abort(new Error(error));
    aborted++;
  }
  turnsByInstance.delete(instanceKey);
  logger.warn({ instanceKey, failure, aborted }, "Aborted turns after browser MCP failure");
  return aborted;
}

onPlaywrightFailure(abortPlaywrightTurns);
