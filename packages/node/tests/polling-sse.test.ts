import { expect, test } from "bun:test";
import { createPollingSseStream } from "../src/polling-sse";

const decoder = new TextDecoder();

function requestWithSignal(signal: AbortSignal): Request {
  return new Request("http://127.0.0.1/events", { signal });
}

test("polling SSE closes immediately when the request is already aborted", async () => {
  const abort = new AbortController();
  abort.abort();
  let pumps = 0;
  const response = createPollingSseStream(requestWithSignal(abort.signal), {
    ready: { ok: true },
    pump: () => {
      pumps += 1;
    },
  });

  expect(await response.body?.getReader().read()).toEqual({ done: true, value: undefined });
  expect(pumps).toBe(0);
});

test("polling SSE turns pump exceptions into a stream error", async () => {
  const abort = new AbortController();
  const failure = new Error("pump failed");
  const response = createPollingSseStream(requestWithSignal(abort.signal), {
    ready: { ok: true },
    pump: () => {
      throw failure;
    },
  });
  const reader = response.body!.getReader();

  await expect(reader.read()).rejects.toThrow("pump failed");
  abort.abort();
});

test("polling SSE contains interval pump exceptions", async () => {
  const abort = new AbortController();
  let pumps = 0;
  const response = createPollingSseStream(requestWithSignal(abort.signal), {
    ready: { ok: true },
    pump: () => {
      pumps += 1;
      if (pumps > 1) throw new Error("interval pump failed");
    },
    pollIntervalMs: 5,
  });
  const reader = response.body!.getReader();

  expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
  await expect(reader.read()).rejects.toThrow("interval pump failed");
});

test("polling SSE contains async pump rejection", async () => {
  const abort = new AbortController();
  const response = createPollingSseStream(requestWithSignal(abort.signal), {
    ready: { ok: true },
    pump: async () => {
      await Bun.sleep(1);
      throw new Error("async pump failed");
    },
  });
  const reader = response.body!.getReader();

  expect(decoder.decode((await reader.read()).value)).toContain("event: ready");
  await expect(reader.read()).rejects.toThrow("async pump failed");
});

test("polling SSE does not overlap async pumps", async () => {
  const abort = new AbortController();
  let active = 0;
  let maxActive = 0;
  let pumps = 0;
  const response = createPollingSseStream(requestWithSignal(abort.signal), {
    ready: { ok: true },
    pump: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      pumps += 1;
      await Bun.sleep(15);
      active -= 1;
    },
    pollIntervalMs: 2,
    heartbeatIntervalMs: 100,
  });
  const reader = response.body!.getReader();

  await reader.read();
  await Bun.sleep(40);
  await reader.cancel();

  expect(pumps).toBeGreaterThan(1);
  expect(maxActive).toBe(1);
});

test("polling SSE stops polling after the reader cancels", async () => {
  const abort = new AbortController();
  let pumps = 0;
  const response = createPollingSseStream(requestWithSignal(abort.signal), {
    ready: { ok: true },
    pump: () => {
      pumps += 1;
    },
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
  });
  const reader = response.body!.getReader();

  const ready = await reader.read();
  expect(decoder.decode(ready.value)).toContain("event: ready");
  await Bun.sleep(20);
  await reader.cancel();
  const pumpsAtCancel = pumps;
  await Bun.sleep(20);

  expect(pumpsAtCancel).toBeGreaterThan(1);
  expect(pumps).toBe(pumpsAtCancel);
});

test("polling SSE stops polling when the request aborts", async () => {
  const abort = new AbortController();
  let pumps = 0;
  const response = createPollingSseStream(requestWithSignal(abort.signal), {
    ready: { ok: true },
    pump: () => {
      pumps += 1;
    },
    pollIntervalMs: 5,
  });
  const reader = response.body!.getReader();

  await reader.read();
  await Bun.sleep(15);
  abort.abort();
  const pumpsAtAbort = pumps;
  expect(await reader.read()).toEqual({ done: true, value: undefined });
  await Bun.sleep(15);

  expect(pumps).toBe(pumpsAtAbort);
});
