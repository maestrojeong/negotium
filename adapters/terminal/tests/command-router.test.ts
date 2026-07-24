import { describe, expect, test } from "bun:test";
import type { NegotiumClient } from "@/client";
import { runTerminalCommand, type TerminalCommandContext } from "@/command-router";
import { createInitialState } from "@/state";

function commandContext(): {
  context: TerminalCommandContext;
  rendered: () => number;
  aborted: () => number;
} {
  let renderCount = 0;
  let abortCount = 0;
  const context: TerminalCommandContext = {
    client: {} as NegotiumClient,
    state: createInitialState("owner"),
    queueRender: () => {
      renderCount += 1;
    },
    requestExit: () => {},
    abort: async () => {
      abortCount += 1;
    },
    openVault: async () => {},
    refreshTopics: async () => {},
    toggleTopics: () => {},
    deriveTopic: async () => {},
    requestTopicDelete: () => {},
    copy: async () => {},
  };
  return {
    context,
    rendered: () => renderCount,
    aborted: () => abortCount,
  };
}

describe("terminal command router", () => {
  test("opens local overlays and schedules a render", async () => {
    const { context, rendered } = commandContext();

    await runTerminalCommand("/help", context);

    expect(context.state.overlay).toBe("help");
    expect(rendered()).toBe(1);
  });

  test("delegates abort without coupling to terminal state", async () => {
    const { context, aborted } = commandContext();

    await runTerminalCommand("/abort", context);

    expect(aborted()).toBe(1);
    expect(context.state.overlay).toBeNull();
  });

  test("validates picker commands before requiring an active topic", async () => {
    const { context, rendered } = commandContext();

    await runTerminalCommand("/model unexpected", context);

    expect(context.state.notice).toBe("Usage: /model");
    expect(rendered()).toBe(1);
  });
});
