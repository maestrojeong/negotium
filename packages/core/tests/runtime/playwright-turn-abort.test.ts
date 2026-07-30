import { describe, expect, it } from "bun:test";
import { AbortReason } from "#query/types";
import {
  abortPlaywrightTurns,
  type PlaywrightTurnControl,
  trackPlaywrightTurn,
  untrackPlaywrightTurn,
} from "#runtime/playwright-turn-abort";

function makeControl(queryId: string): PlaywrightTurnControl {
  return {
    topicId: `topic-${queryId}`,
    queryId,
    abortController: new AbortController(),
    abortReason: AbortReason.None,
  };
}

describe("playwright turn abort registry", () => {
  it("aborts every active turn sharing the browser instance", () => {
    const first = makeControl("first");
    const second = makeControl("second");
    trackPlaywrightTurn("profile:shared", first);
    trackPlaywrightTurn("profile:shared", second);

    expect(abortPlaywrightTurns("profile:shared", { reason: "exit", code: 137 })).toBe(2);
    for (const control of [first, second]) {
      expect(control.abortController.signal.aborted).toBe(true);
      expect(control.abortReason).toBe(AbortReason.Infrastructure);
      expect(control.abortError).toContain("exitCode=137");
    }
    expect(abortPlaywrightTurns("profile:shared", { reason: "exit", code: 137 })).toBe(0);
  });

  it("does not abort a turn after it releases the browser instance", () => {
    const control = makeControl("released");
    trackPlaywrightTurn("profile:released", control);
    untrackPlaywrightTurn("profile:released", control);

    expect(abortPlaywrightTurns("profile:released", { reason: "unhealthy" })).toBe(0);
    expect(control.abortController.signal.aborted).toBe(false);
  });

  it("distinguishes an unresponsive transport from a process exit", () => {
    const control = makeControl("unhealthy");
    trackPlaywrightTurn("profile:unhealthy", control);

    expect(abortPlaywrightTurns("profile:unhealthy", { reason: "unhealthy" })).toBe(1);
    expect(control.abortError).toContain("transport became unresponsive");
    expect(control.abortReason).toBe(AbortReason.Infrastructure);
  });
});
