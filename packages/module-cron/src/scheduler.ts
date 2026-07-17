import {
  type AgentKind,
  type AiTurnSettlement,
  abortRoom,
  getRoomQuery,
  getTopic,
  logger,
  type MessageDto,
  type RuntimeBus,
  runtimeBus,
} from "@negotium/core";
import { CRON_CONTEXT_ROTATE_EVERY, rotateCronTopicContext } from "#context";
import {
  type CronJobRecord,
  type CronRunRecord,
  claimCronCancellations,
  claimCronRuns,
  clearCronTopicSession,
  cronTopicSessionName,
  finalizeOrphanedCronRuns,
  finishCronRun,
  getCronJob,
  getCronTopicContext,
  getCronTopicSession,
  markCronRunStarted,
  recoverPendingCronRuns,
  setCronJobEnabled,
  setCronTopicSessionIfJobUpdatedAt,
} from "#store";

export interface CronDispatchHooks {
  onDispatched(queryId: string): void;
  onSessionId(sessionId: string): void;
  onSessionReset(): void;
  onSettled(result: AiTurnSettlement): void;
}

export interface CronExecutionContext {
  agent: AgentKind;
  sessionId?: string;
  sessionName: string;
  signal: AbortSignal;
}

export type CronDispatchResult =
  | string
  | null
  | { status: "skipped"; reason: string }
  | {
      status: "deferred" | "dispatched";
      requestId: string;
      queryId?: string;
      cancel(): boolean;
    };

export type CronDispatch = (
  job: CronJobRecord,
  run: CronRunRecord,
  hooks: CronDispatchHooks,
  context: CronExecutionContext,
) => CronDispatchResult | Promise<CronDispatchResult>;

export interface CronSchedulerOptions {
  dispatch: CronDispatch;
  bus?: RuntimeBus;
  pollIntervalMs?: number;
  runTimeoutMs?: number;
  queueTimeoutMs?: number;
  now?: () => Date;
}

interface ActiveRun {
  job: CronJobRecord;
  run: CronRunRecord;
  agent: AgentKind;
  queryId?: string;
  outputPreview?: string;
  timeout?: ReturnType<typeof setTimeout>;
  deferredTimeout?: ReturnType<typeof setTimeout>;
  cancelDeferred?: () => boolean;
  abortController: AbortController;
}

interface QueuedRun {
  job: CronJobRecord;
  run: CronRunRecord;
  queuedAt: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60_000;

/**
 * One durable scheduler per node process.
 *
 * SQLite owns due/manual requests. The in-memory layer only serializes work
 * per topic: every job attached to a topic observes the provider session and
 * provider-agnostic conversation log written by the previous topic Cron run.
 */
export class CronScheduler {
  readonly #dispatch: CronDispatch;
  readonly #bus: RuntimeBus;
  readonly #pollIntervalMs: number;
  readonly #runTimeoutMs: number;
  readonly #queueTimeoutMs: number;
  readonly #now: () => Date;
  readonly #activeByTopic = new Map<string, ActiveRun>();
  readonly #activeByQuery = new Map<string, ActiveRun>();
  readonly #queuedByTopic = new Map<string, QueuedRun[]>();
  readonly #maintenanceByTopic = new Set<string>();
  readonly #rotationBypassOnce = new Set<string>();
  #timer?: ReturnType<typeof setInterval>;
  #unsubscribe?: () => void;
  #ticking = false;
  #stopped = false;

  constructor(options: CronSchedulerOptions) {
    this.#dispatch = options.dispatch;
    this.#bus = options.bus ?? runtimeBus();
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.#runTimeoutMs = Math.max(1_000, options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    this.#queueTimeoutMs = Math.max(1_000, options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS);
    this.#now = options.now ?? (() => new Date());
  }

  start(): () => void {
    if (this.#timer) return () => this.stop();
    this.#stopped = false;
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
    const recovered = recoverPendingCronRuns();
    for (const pending of recovered) this.#enqueueOrStart(pending.job, pending.run);
    if (recovered.length > 0) {
      logger.info({ recovered: recovered.length }, "cron: recovered pending pre-dispatch runs");
    }
    void this.tick();
    return () => this.stop();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;

    for (const active of [...this.#activeByTopic.values()]) {
      active.abortController.abort();
      active.cancelDeferred?.();
      if (active.queryId && getRoomQuery(active.job.topicId)?.queryId === active.queryId) {
        abortRoom(active.job.topicId);
      }
      this.#finish(active, "aborted", "scheduler stopped before run completed");
    }
    for (const queued of this.#queuedByTopic.values()) {
      for (const entry of queued) {
        finishCronRun(entry.run.id, {
          status: "aborted",
          error: "scheduler stopped before queued run dispatched",
        });
      }
    }
    this.#queuedByTopic.clear();
    this.#activeByTopic.clear();
    this.#activeByQuery.clear();
    this.#rotationBypassOnce.clear();
  }

  async tick(): Promise<void> {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      for (const jobId of claimCronCancellations()) this.#cancelJob(jobId);
      for (const claimed of claimCronRuns(this.#now())) {
        this.#enqueueOrStart(claimed.job, claimed.run);
      }
    } catch (error) {
      logger.warn({ err: error }, "cron: scheduler tick failed");
    } finally {
      this.#ticking = false;
    }
  }

  #enqueueOrStart(job: CronJobRecord, run: CronRunRecord): void {
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

    if (this.#activeByTopic.has(job.topicId) || this.#maintenanceByTopic.has(job.topicId)) {
      const queue = this.#queuedByTopic.get(job.topicId) ?? [];
      queue.push({ job, run, queuedAt: this.#now().getTime() });
      this.#queuedByTopic.set(job.topicId, queue);
      return;
    }
    const rotationDue =
      (getCronTopicContext(job.topicId)?.successfulRunsSinceRotation ?? 0) >=
      CRON_CONTEXT_ROTATE_EVERY;
    if (rotationDue && !this.#rotationBypassOnce.delete(job.topicId)) {
      const queue = this.#queuedByTopic.get(job.topicId) ?? [];
      queue.push({ job, run, queuedAt: this.#now().getTime() });
      this.#queuedByTopic.set(job.topicId, queue);
      this.#beginContextRotation(job.topicId);
      return;
    }
    this.#start(job, run, job.agent ?? topic.agent);
  }

  #start(job: CronJobRecord, run: CronRunRecord, agent: AgentKind): void {
    const storedSession = getCronTopicSession(job.topicId, agent);
    if (storedSession && storedSession.ownerUserId !== job.ownerUserId) {
      setCronJobEnabled(job.id, false, this.#now());
      finishCronRun(run.id, {
        status: "failed",
        error: "topic Cron context belongs to another owner; job disabled",
      });
      this.#drainTopic(job.topicId);
      return;
    }
    const active: ActiveRun = { job, run, agent, abortController: new AbortController() };
    this.#activeByTopic.set(job.topicId, active);
    const hooks: CronDispatchHooks = {
      onDispatched: (queryId) => this.#markDispatched(active, queryId),
      onSessionId: (sessionId) => {
        if (this.#isActive(active)) {
          setCronTopicSessionIfJobUpdatedAt(
            job.id,
            job.updatedAt,
            job.topicId,
            agent,
            job.ownerUserId,
            sessionId,
            this.#now(),
          );
        }
      },
      onSessionReset: () => {
        if (this.#isActive(active) && getCronJob(job.id)?.updatedAt === job.updatedAt) {
          clearCronTopicSession(job.topicId, agent);
        }
      },
      onSettled: (result) => this.#settle(active, result),
    };
    const context: CronExecutionContext = {
      agent,
      sessionId: storedSession?.sessionId,
      sessionName: cronTopicSessionName(job.topicId),
      signal: active.abortController.signal,
    };

    Promise.resolve()
      .then(() => this.#dispatch(job, run, hooks, context))
      .then((result) => this.#handleDispatchResult(active, result))
      .catch((error) => {
        this.#finish(active, "failed", error instanceof Error ? error.message : String(error));
      });
  }

  #handleDispatchResult(active: ActiveRun, result: CronDispatchResult): void {
    if (!this.#isActive(active)) return;
    if (typeof result === "string") {
      if (active.queryId !== result) this.#markDispatched(active, result);
      return;
    }
    if (result === null) {
      this.#finish(active, "failed", "dispatch returned no query and no deferred handle");
      return;
    }
    if (result.status === "skipped") {
      this.#finish(active, "skipped", result.reason);
      return;
    }

    active.cancelDeferred = result.cancel;
    if (result.status === "dispatched") {
      if (result.queryId && active.queryId !== result.queryId) {
        this.#markDispatched(active, result.queryId);
      }
      return;
    }
    active.deferredTimeout = setTimeout(() => {
      if (!this.#isActive(active) || active.queryId) return;
      const cancelled = active.cancelDeferred?.() ?? false;
      this.#finish(
        active,
        cancelled ? "skipped" : "failed",
        cancelled
          ? `topic remained busy for more than ${this.#queueTimeoutMs}ms`
          : "deferred run disappeared before dispatch",
      );
    }, this.#queueTimeoutMs);
    active.deferredTimeout.unref?.();
  }

  #markDispatched(active: ActiveRun, queryId: string): void {
    if (!this.#isActive(active)) return;
    if (active.queryId) this.#activeByQuery.delete(active.queryId);
    if (active.timeout) clearTimeout(active.timeout);
    if (active.deferredTimeout) clearTimeout(active.deferredTimeout);
    active.deferredTimeout = undefined;
    active.queryId = queryId;
    this.#activeByQuery.set(queryId, active);
    markCronRunStarted(active.run.id, queryId, this.#now());
    active.timeout = setTimeout(() => {
      const room = getRoomQuery(active.job.topicId);
      if (room?.queryId === active.queryId) abortRoom(active.job.topicId);
      else active.cancelDeferred?.();
      this.#finish(active, "failed", `run exceeded ${this.#runTimeoutMs}ms`);
    }, this.#runTimeoutMs);
    active.timeout.unref?.();
  }

  #settle(active: ActiveRun, result: AiTurnSettlement): void {
    if (!this.#isActive(active)) return;
    if (result.queryId && active.queryId && result.queryId !== active.queryId) return;
    if (result.kind === "completed") this.#finish(active, "succeeded");
    else if (result.kind === "aborted") this.#finish(active, "aborted", result.error);
    else this.#finish(active, "failed", result.error ?? "agent turn failed");
  }

  #finish(
    active: ActiveRun,
    status: "succeeded" | "failed" | "aborted" | "skipped",
    error?: string,
  ): void {
    if (!this.#isActive(active)) return;
    active.abortController.abort();
    if (active.timeout) clearTimeout(active.timeout);
    if (active.deferredTimeout) clearTimeout(active.deferredTimeout);
    if (active.queryId) this.#activeByQuery.delete(active.queryId);
    this.#activeByTopic.delete(active.job.topicId);
    const successfulRunsSinceRotation = finishCronRun(
      active.run.id,
      { status, outputPreview: active.outputPreview, error },
      this.#now(),
    );
    if (
      status === "succeeded" &&
      successfulRunsSinceRotation !== null &&
      successfulRunsSinceRotation >= CRON_CONTEXT_ROTATE_EVERY
    ) {
      this.#beginContextRotation(active.job.topicId);
      return;
    }
    if (!this.#stopped) queueMicrotask(() => this.#drainTopic(active.job.topicId));
  }

  #beginContextRotation(topicId: string): void {
    if (this.#stopped || this.#maintenanceByTopic.has(topicId)) return;
    this.#maintenanceByTopic.add(topicId);
    void rotateCronTopicContext(topicId)
      .then((result) => {
        if (!result.rotated) {
          this.#rotationBypassOnce.add(topicId);
          logger.warn({ topicId }, "cron: context rotation deferred after cleanup failure");
        }
      })
      .catch((error) => {
        this.#rotationBypassOnce.add(topicId);
        logger.warn({ err: error, topicId }, "cron: context rotation failed");
      })
      .finally(() => {
        this.#maintenanceByTopic.delete(topicId);
        if (!this.#stopped) this.#drainTopic(topicId);
      });
  }

  #drainTopic(topicId: string): void {
    if (this.#stopped || this.#activeByTopic.has(topicId) || this.#maintenanceByTopic.has(topicId))
      return;
    const queue = this.#queuedByTopic.get(topicId);
    while (queue?.length) {
      const next = queue.shift()!;
      if (this.#now().getTime() - next.queuedAt > this.#queueTimeoutMs) {
        finishCronRun(next.run.id, {
          status: "skipped",
          error: `topic Cron queue wait exceeded ${this.#queueTimeoutMs}ms`,
        });
        continue;
      }
      const currentJob = getCronJob(next.job.id);
      if (!currentJob) continue;
      if (queue.length === 0) this.#queuedByTopic.delete(topicId);
      this.#enqueueOrStart(currentJob, next.run);
      return;
    }
    this.#queuedByTopic.delete(topicId);
  }

  #cancelJob(jobId: string): void {
    for (const active of [...this.#activeByTopic.values()]) {
      if (active.job.id !== jobId) continue;
      active.abortController.abort();
      active.cancelDeferred?.();
      if (active.queryId && getRoomQuery(active.job.topicId)?.queryId === active.queryId) {
        abortRoom(active.job.topicId);
      }
      this.#finish(active, "aborted", "run cancelled by cron_kill");
    }
    for (const [topicId, queue] of this.#queuedByTopic) {
      const kept: QueuedRun[] = [];
      for (const queued of queue) {
        if (queued.job.id === jobId) {
          finishCronRun(queued.run.id, {
            status: "aborted",
            error: "queued run cancelled by cron_kill",
          });
        } else {
          kept.push(queued);
        }
      }
      if (kept.length > 0) this.#queuedByTopic.set(topicId, kept);
      else this.#queuedByTopic.delete(topicId);
    }
  }

  #isActive(active: ActiveRun): boolean {
    return this.#activeByTopic.get(active.job.topicId) === active;
  }
}
