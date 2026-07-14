import {
  type AiTurnSettlement,
  abortRoom,
  getRoomQuery,
  getTopic,
  logger,
  type MessageDto,
  type RuntimeBus,
  runtimeBus,
} from "@negotium/core";
import {
  type CronJobRecord,
  type CronRunRecord,
  claimCronRuns,
  finalizeOrphanedCronRuns,
  finishCronRun,
  markCronRunStarted,
  setCronJobEnabled,
  setCronJobSessionId,
} from "#store";

export interface CronDispatchHooks {
  onDispatched(queryId: string): void;
  onSessionId(sessionId: string): void;
  onSettled(result: AiTurnSettlement): void;
}

export type CronDispatch = (
  job: CronJobRecord,
  run: CronRunRecord,
  hooks: CronDispatchHooks,
) => string | null;

export interface CronSchedulerOptions {
  dispatch: CronDispatch;
  bus?: RuntimeBus;
  pollIntervalMs?: number;
  runTimeoutMs?: number;
  now?: () => Date;
}

interface ActiveRun {
  jobId: string;
  topicId: string;
  runId: string;
  queryId?: string;
  outputPreview?: string;
  timeout?: ReturnType<typeof setTimeout>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/**
 * One lightweight scheduler per long-lived node process.
 *
 * The DB stores the next due instant, so idle work is one indexed query per
 * tick rather than re-parsing every schedule. Turns still enter core through
 * its normal inject queue and therefore never preempt a human turn.
 */
export class CronScheduler {
  readonly #dispatch: CronDispatch;
  readonly #bus: RuntimeBus;
  readonly #pollIntervalMs: number;
  readonly #runTimeoutMs: number;
  readonly #now: () => Date;
  readonly #activeByJob = new Map<string, ActiveRun>();
  readonly #activeByQuery = new Map<string, ActiveRun>();
  #timer?: ReturnType<typeof setInterval>;
  #unsubscribe?: () => void;
  #ticking = false;

  constructor(options: CronSchedulerOptions) {
    this.#dispatch = options.dispatch;
    this.#bus = options.bus ?? runtimeBus();
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.#runTimeoutMs = Math.max(1_000, options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    this.#now = options.now ?? (() => new Date());
  }

  start(): () => void {
    if (this.#timer) return () => this.stop();
    const orphaned = finalizeOrphanedCronRuns(this.#now());
    if (orphaned > 0) logger.warn({ orphaned }, "cron: finalized interrupted runs on startup");
    this.#unsubscribe = this.#bus.subscribe((event) => {
      if (event.type !== "message") return;
      const message = event.payload as MessageDto;
      if (!message?.queryId || message.authorId !== "ai") return;
      const active = this.#activeByQuery.get(message.queryId);
      if (active) active.outputPreview = message.text.slice(0, 500);
    });
    this.#timer = setInterval(() => void this.tick(), this.#pollIntervalMs);
    this.#timer.unref?.();
    void this.tick();
    return () => this.stop();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const active of this.#activeByJob.values()) {
      if (active.timeout) clearTimeout(active.timeout);
    }
    this.#activeByJob.clear();
    this.#activeByQuery.clear();
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const claimed of claimCronRuns(this.#now()))
        this.#startClaimed(claimed.job, claimed.run);
    } catch (error) {
      logger.warn({ err: error }, "cron: scheduler tick failed");
    } finally {
      this.#ticking = false;
    }
  }

  #startClaimed(job: CronJobRecord, run: CronRunRecord): void {
    if (this.#activeByJob.has(job.id)) {
      finishCronRun(run.id, {
        status: "skipped",
        error: "previous run is still active",
      });
      return;
    }
    const topic = getTopic(job.topicId);
    if (!topic?.agent) {
      setCronJobEnabled(job.id, false, this.#now());
      finishCronRun(run.id, {
        status: "failed",
        error: "target topic is missing or has no agent; job disabled",
      });
      return;
    }
    if (!topic.participants.some((participant) => participant.userId === job.ownerUserId)) {
      setCronJobEnabled(job.id, false, this.#now());
      finishCronRun(run.id, {
        status: "failed",
        error: "job owner is no longer a topic participant; job disabled",
      });
      return;
    }

    const active: ActiveRun = { jobId: job.id, topicId: job.topicId, runId: run.id };
    this.#activeByJob.set(job.id, active);
    const hooks: CronDispatchHooks = {
      onDispatched: (queryId) => this.#markDispatched(active, queryId),
      onSessionId: (sessionId) => setCronJobSessionId(job.id, sessionId),
      onSettled: (result) => this.#settle(active, result),
    };
    try {
      const queryId = this.#dispatch(job, run, hooks);
      if (queryId && active.queryId !== queryId) this.#markDispatched(active, queryId);
      // null means the core inject queue accepted the run behind a busy human
      // turn. onDispatched will fire when it actually claims the room.
    } catch (error) {
      this.#finish(active, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  #markDispatched(active: ActiveRun, queryId: string): void {
    if (!this.#activeByJob.has(active.jobId)) return;
    if (active.queryId) this.#activeByQuery.delete(active.queryId);
    if (active.timeout) clearTimeout(active.timeout);
    active.queryId = queryId;
    this.#activeByQuery.set(queryId, active);
    markCronRunStarted(active.runId, queryId, this.#now());
    active.timeout = setTimeout(() => {
      const room = getRoomQuery(active.topicId);
      if (room?.queryId === active.queryId) abortRoom(active.topicId);
      this.#finish(active, "failed", `run exceeded ${this.#runTimeoutMs}ms`);
    }, this.#runTimeoutMs);
    active.timeout.unref?.();
  }

  #settle(active: ActiveRun, result: AiTurnSettlement): void {
    if (!this.#activeByJob.has(active.jobId)) return;
    if (result.queryId && active.queryId && result.queryId !== active.queryId) return;
    if (result.kind === "completed") this.#finish(active, "succeeded");
    else if (result.kind === "aborted") this.#finish(active, "aborted", result.error);
    else this.#finish(active, "failed", result.error ?? "agent turn failed");
  }

  #finish(active: ActiveRun, status: "succeeded" | "failed" | "aborted", error?: string): void {
    if (!this.#activeByJob.has(active.jobId)) return;
    if (active.timeout) clearTimeout(active.timeout);
    if (active.queryId) this.#activeByQuery.delete(active.queryId);
    this.#activeByJob.delete(active.jobId);
    finishCronRun(
      active.runId,
      { status, outputPreview: active.outputPreview, error },
      this.#now(),
    );
  }
}
