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
