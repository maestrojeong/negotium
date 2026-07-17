import { describe, expect, test } from "bun:test";
import {
  createDurableOutboxWorker,
  type DurableOutboxEntry,
  type DurableOutboxRetry,
} from "@/outbox";

interface Entry extends DurableOutboxEntry {
  id: number;
  nextTryAt: number;
  dead: boolean;
}

function fixture(maxAttempts = 3) {
  let clock = 1_000;
  const entries: Entry[] = [{ id: 1, attempts: 0, nextTryAt: clock, dead: false }];
  const delivered: number[] = [];
  let failure: Error | null = new Error("offline");
  const worker = createDurableOutboxWorker<Entry, number>({
    now: () => clock,
    policy: { pollMs: 10, baseDelayMs: 100, maxDelayMs: 1_000, maxAttempts },
    store: {
      due: (now) => entries.filter((entry) => !entry.dead && entry.nextTryAt <= now),
      hasPending: () => entries.some((entry) => !entry.dead),
      acknowledge: (entry, value) => {
        entries.splice(entries.indexOf(entry), 1);
        delivered.push(value);
      },
      discard: (entry) => {
        entries.splice(entries.indexOf(entry), 1);
      },
      retry: (entry, retry: DurableOutboxRetry) => {
        Object.assign(entry, retry);
      },
      deadLetter: (entry, retry) => {
        Object.assign(entry, retry, { dead: true });
      },
    },
    deliver: async (entry) => {
      if (failure) throw failure;
      return entry.id;
    },
    classifyError: (error) => ({ message: (error as Error).message }),
  });
  return {
    worker,
    entries,
    delivered,
    setClock: (value: number) => {
      clock = value;
    },
    recover: () => {
      failure = null;
    },
  };
}

describe("durable outbox worker", () => {
  test("uses the injected clock for exponential retry and acknowledges recovery", async () => {
    const state = fixture();
    await state.worker.flush();
    expect(state.entries[0]).toMatchObject({ attempts: 1, nextTryAt: 1_100, dead: false });

    state.setClock(1_100);
    state.recover();
    await state.worker.flush();
    expect(state.entries).toHaveLength(0);
    expect(state.delivered).toEqual([1]);
  });

  test("dead-letters at the configured attempt limit", async () => {
    const state = fixture(2);
    await state.worker.flush();
    state.setClock(1_100);
    await state.worker.flush();
    expect(state.entries[0]).toMatchObject({ attempts: 2, dead: true });
  });

  test("honors a transport-provided retry delay", async () => {
    const clock = 500;
    const entry: Entry = { id: 1, attempts: 0, nextTryAt: 500, dead: false };
    const worker = createDurableOutboxWorker<Entry, void>({
      now: () => clock,
      policy: { pollMs: 10, baseDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
      store: {
        due: () => [entry],
        hasPending: () => true,
        acknowledge: () => {},
        discard: () => {},
        retry: (_entry, retry) => {
          Object.assign(entry, retry);
        },
        deadLetter: () => {},
      },
      deliver: async () => {
        throw new Error("rate limited");
      },
      classifyError: () => ({ message: "rate limited", retryAfterMs: 2_500 }),
    });
    await worker.flush();
    expect(entry.nextTryAt).toBe(3_000);
  });

  test("retries acknowledgement without delivering the entry twice", async () => {
    const entry: Entry = { id: 1, attempts: 0, nextTryAt: 0, dead: false };
    let deliveryAttempts = 0;
    let acknowledgementAttempts = 0;
    let acknowledged = false;
    const errors: unknown[] = [];
    const worker = createDurableOutboxWorker<Entry, number>({
      policy: { pollMs: 10, baseDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
      store: {
        due: () => (acknowledged ? [] : [entry]),
        hasPending: () => !acknowledged,
        acknowledge: () => {
          acknowledgementAttempts++;
          if (acknowledgementAttempts === 1) throw new Error("database busy");
          acknowledged = true;
        },
        discard: () => {},
        retry: () => {},
        deadLetter: () => {},
      },
      deliver: async () => ++deliveryAttempts,
      classifyError: (error) => ({ message: (error as Error).message }),
      onError: (error) => errors.push(error),
    });

    await worker.flush();
    await worker.flush();

    expect(deliveryAttempts).toBe(1);
    expect(acknowledgementAttempts).toBe(2);
    expect(acknowledged).toBe(true);
    expect(errors).toHaveLength(1);
  });

  test("keeps polling when the pending-state check fails", async () => {
    const scheduled: Array<() => void> = [];
    const errors: unknown[] = [];
    const worker = createDurableOutboxWorker<Entry, void, number>({
      policy: { pollMs: 10, baseDelayMs: 100, maxDelayMs: 1_000, maxAttempts: 3 },
      store: {
        due: () => [],
        hasPending: () => {
          throw new Error("database unavailable");
        },
        acknowledge: () => {},
        discard: () => {},
        retry: () => {},
        deadLetter: () => {},
      },
      deliver: async () => {},
      classifyError: (error) => ({ message: (error as Error).message }),
      onError: (error) => errors.push(error),
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: () => {},
    });

    worker.start();
    const firstPoll = scheduled.shift();
    expect(firstPoll).toBeDefined();
    firstPoll?.();
    await Bun.sleep(0);

    expect(errors).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
    worker.stop();
  });
});
