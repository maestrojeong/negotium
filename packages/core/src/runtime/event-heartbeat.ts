import type { UnifiedEvent } from "#types";

/** Matches Otium's extended-thinking heartbeat cadence. */
export const TURN_SILENCE_HEARTBEAT_MS = 5_000;

export interface TurnSilenceHeartbeatOptions {
  intervalMs?: number;
  now?: () => number;
}

type HeartbeatRace =
  | { kind: "event"; result: IteratorResult<UnifiedEvent> }
  | { kind: "heartbeat" };

function nextOrHeartbeat(
  pending: Promise<IteratorResult<UnifiedEvent>>,
  intervalMs: number,
): Promise<HeartbeatRace> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: "heartbeat" }), intervalMs);
    timer.unref?.();
    pending.then(
      (result) => {
        clearTimeout(timer);
        resolve({ kind: "event", result });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Keep channel UIs visibly alive while an agent stream is silent.
 *
 * Otium emits provider-specific `thinking` progress from Claude SDK signals.
 * Negotium also hosts Codex, Maestro, MCP startup, and other phases that can
 * legitimately produce no events for a while, so the host-neutral runtime
 * adds a fallback heartbeat after each silent interval. Real provider events
 * always win the race and restart the silence timer.
 */
export async function* withTurnSilenceHeartbeat(
  events: AsyncIterable<UnifiedEvent>,
  options: TurnSilenceHeartbeatOptions = {},
): AsyncGenerator<UnifiedEvent> {
  const intervalMs = Math.max(1, options.intervalMs ?? TURN_SILENCE_HEARTBEAT_MS);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const iterator = events[Symbol.asyncIterator]();
  let pending = iterator.next();

  try {
    while (true) {
      const next = await nextOrHeartbeat(pending, intervalMs);

      if (next.kind === "heartbeat") {
        yield {
          type: "tool_progress",
          toolName: "working",
          elapsed: Math.max(0, (now() - startedAt) / 1_000),
        };
        continue;
      }

      if (next.result.done) return;
      yield next.result.value;
      pending = iterator.next();
    }
  } finally {
    // Do not await a stuck provider here. Its own abort controller/process
    // cleanup remains authoritative, while the outer turn can settle promptly.
    const closing = iterator.return?.();
    if (closing) void Promise.resolve(closing).catch(() => undefined);
  }
}
