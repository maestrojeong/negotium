export type OutboxAwaitable<T> = T | Promise<T>;

export interface DurableOutboxEntry {
  attempts: number;
}

export interface DurableOutboxFailure {
  message: string;
  retryAfterMs?: number;
}

export interface DurableOutboxRetry {
  attempts: number;
  nextTryAt: number;
  error: string;
}

export interface DurableOutboxPolicy {
  pollMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface DurableOutboxStore<Entry extends DurableOutboxEntry, Delivery> {
  due(now: number): OutboxAwaitable<readonly Entry[]>;
  hasPending(): OutboxAwaitable<boolean>;
  acknowledge(entry: Entry, delivery: Delivery): OutboxAwaitable<void>;
  discard(entry: Entry): OutboxAwaitable<void>;
  retry(entry: Entry, retry: DurableOutboxRetry): OutboxAwaitable<void>;
  deadLetter(entry: Entry, retry: Omit<DurableOutboxRetry, "nextTryAt">): OutboxAwaitable<void>;
}

export interface DurableOutboxWorkerOptions<
  Entry extends DurableOutboxEntry,
  Delivery,
  Timer = ReturnType<typeof setTimeout>,
> {
  store: DurableOutboxStore<Entry, Delivery>;
  deliver(entry: Entry): Promise<Delivery>;
  classifyError(error: unknown): DurableOutboxFailure;
  policy: DurableOutboxPolicy;
  shouldDiscard?(entry: Entry): OutboxAwaitable<boolean>;
  onEntryStart?(entry: Entry): void;
  onEntryEnd?(entry: Entry): void;
  onDeadLetter?(entry: Entry, retry: Omit<DurableOutboxRetry, "nextTryAt">): void;
  onError?(error: unknown): void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => Timer;
  cancel?: (timer: Timer) => void;
}

export interface DurableOutboxWorker {
  start(): void;
  wake(): void;
  flush(): Promise<void>;
  stop(): void;
}

export function exponentialOutboxBackoff(
  attempts: number,
  policy: Pick<DurableOutboxPolicy, "baseDelayMs" | "maxDelayMs">,
): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempts - 1), policy.maxDelayMs);
}

/** Drive a durable store without coupling retry policy to a transport or database. */
export function createDurableOutboxWorker<
  Entry extends DurableOutboxEntry,
  Delivery,
  Timer = ReturnType<typeof setTimeout>,
>(options: DurableOutboxWorkerOptions<Entry, Delivery, Timer>): DurableOutboxWorker {
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs) as Timer);
  const cancel =
    options.cancel ?? ((timer: Timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: Timer | undefined;
  let started = false;
  let stopped = false;
  let flushing: Promise<void> | null = null;
  let pendingAcknowledgement: { entry: Entry; delivery: Delivery } | null = null;

  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // An observer must not stop durable delivery recovery.
    }
  };

  const scheduleFlush = (): void => {
    if (!started || stopped || timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      void flush();
    }, options.policy.pollMs);
  };

  const performFlush = async (): Promise<void> => {
    let entries: readonly Entry[] = [];
    const released = new Set<Entry>();
    const release = (entry: Entry): void => {
      if (released.has(entry)) return;
      released.add(entry);
      options.onEntryEnd?.(entry);
    };
    try {
      if (pendingAcknowledgement) {
        const pending = pendingAcknowledgement;
        try {
          await options.store.acknowledge(pending.entry, pending.delivery);
          pendingAcknowledgement = null;
        } catch (error) {
          reportError(error);
          return;
        }
      }
      entries = await options.store.due(now());
      for (const entry of entries) options.onEntryStart?.(entry);
      for (const entry of entries) {
        if (stopped) return;
        if (await options.shouldDiscard?.(entry)) {
          await options.store.discard(entry);
          release(entry);
          continue;
        }
        let delivery: Delivery;
        try {
          delivery = await options.deliver(entry);
        } catch (error) {
          if (stopped) return;
          const failure = options.classifyError(error);
          const attempts = entry.attempts + 1;
          const retry = { attempts, error: failure.message };
          if (attempts >= options.policy.maxAttempts) {
            await options.store.deadLetter(entry, retry);
            options.onDeadLetter?.(entry, retry);
          } else {
            const delay =
              failure.retryAfterMs ?? exponentialOutboxBackoff(attempts, options.policy);
            await options.store.retry(entry, {
              ...retry,
              nextTryAt: now() + Math.max(0, delay),
            });
          }
          release(entry);
          continue;
        }
        if (stopped) return;
        pendingAcknowledgement = { entry, delivery };
        try {
          await options.store.acknowledge(entry, delivery);
          pendingAcknowledgement = null;
        } catch (error) {
          reportError(error);
          release(entry);
          return;
        }
        release(entry);
      }
    } catch (error) {
      if (!stopped) reportError(error);
    } finally {
      for (const entry of entries) release(entry);
      if (!stopped && started) {
        let hasPending = pendingAcknowledgement !== null;
        if (!hasPending) {
          try {
            hasPending = await options.store.hasPending();
          } catch (error) {
            reportError(error);
            hasPending = true;
          }
        }
        if (hasPending) scheduleFlush();
      }
    }
  };

  const flush = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (flushing) return flushing;
    flushing = performFlush().finally(() => {
      flushing = null;
    });
    return flushing;
  };

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      scheduleFlush();
    },
    wake(): void {
      scheduleFlush();
    },
    flush,
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    },
  };
}
