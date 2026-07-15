import { describe, expect, test } from "bun:test";
import { withTurnSilenceHeartbeat } from "#runtime/event-heartbeat";
import type { UnifiedEvent } from "#types";

async function collect(events: AsyncIterable<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const output: UnifiedEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe("turn silence heartbeat", () => {
  test("emits working progress while a provider stream is silent", async () => {
    async function* provider(): AsyncGenerator<UnifiedEvent> {
      await Bun.sleep(35);
      yield { type: "status", content: "provider ready" };
    }

    const events = await collect(withTurnSilenceHeartbeat(provider(), { intervalMs: 10 }));
    const beats = events.filter(
      (event): event is Extract<UnifiedEvent, { type: "tool_progress" }> =>
        event.type === "tool_progress",
    );

    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats.every((event) => event.toolName === "working")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "status", content: "provider ready" });
  });

  test("does not invent progress when real events arrive before the interval", async () => {
    async function* provider(): AsyncGenerator<UnifiedEvent> {
      yield { type: "status", content: "ready" };
      yield { type: "result", content: "done", stopReason: "end_turn" };
    }

    expect(await collect(withTurnSilenceHeartbeat(provider(), { intervalMs: 50 }))).toEqual([
      { type: "status", content: "ready" },
      { type: "result", content: "done", stopReason: "end_turn" },
    ]);
  });
});
