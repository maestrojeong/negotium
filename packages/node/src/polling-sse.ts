export type SseSend = (event: string, data: unknown, id?: number) => void;

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

  const stopTimers = () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send: SseSend = (event, data, id) => {
        if (closed) return;
        const lines = [
          id === undefined ? "" : `id: ${id}`,
          `event: ${event}`,
          `data: ${JSON.stringify(data)}`,
        ]
          .filter(Boolean)
          .join("\n");
        controller.enqueue(encoder.encode(`${lines}\n\n`));
      };
      const close = () => {
        if (closed) return;
        stopTimers();
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
        } finally {
          pumping = false;
        }
      };

      send("ready", options.ready);
      pump();
      pollTimer = setInterval(pump, options.pollIntervalMs ?? 100);
      heartbeatTimer = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, options.heartbeatIntervalMs ?? 15_000);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      stopTimers();
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
