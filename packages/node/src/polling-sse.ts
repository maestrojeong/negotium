type SseSend = (event: string, data: unknown, id?: number) => void;

export interface PollingSseOptions {
  ready: unknown;
  pump: (send: SseSend) => void;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

/** Shared polling/heartbeat transport for node SSE endpoints. */
export function createPollingSseStream(req: Request, options: PollingSseOptions): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let pumping = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const stop = () => {
    if (closed) return false;
    closed = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    removeAbortListener?.();
    removeAbortListener = undefined;
    return true;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (error: unknown) => {
        if (!stop()) return;
        try {
          controller.error(error);
        } catch {
          // The peer may already have closed the stream.
        }
      };
      const send: SseSend = (event, data, id) => {
        if (closed) return;
        try {
          const lines = [
            id === undefined ? "" : `id: ${id}`,
            `event: ${event}`,
            `data: ${JSON.stringify(data)}`,
          ]
            .filter(Boolean)
            .join("\n");
          controller.enqueue(encoder.encode(`${lines}\n\n`));
        } catch (error) {
          fail(error);
        }
      };
      const close = () => {
        if (!stop()) return;
        try {
          controller.close();
        } catch {
          // The peer may already have closed the stream.
        }
      };
      const pump = () => {
        if (closed || pumping) return;
        pumping = true;
        try {
          options.pump(send);
        } catch (error) {
          fail(error);
        } finally {
          pumping = false;
        }
      };

      if (req.signal.aborted) {
        close();
        return;
      }
      const onAbort = () => close();
      req.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => req.signal.removeEventListener("abort", onAbort);

      send("ready", options.ready);
      pump();
      if (closed) return;
      pollTimer = setInterval(pump, options.pollIntervalMs ?? 100);
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch (error) {
          fail(error);
        }
      }, options.heartbeatIntervalMs ?? 15_000);
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
