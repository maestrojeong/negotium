import { describe, expect, test } from "bun:test";
import type { ForkHandle } from "#agents/fork";
import { createAskForkPlan } from "#runtime/inbox";
import { prepareInjectReplayAfterUserPreemption } from "#runtime/turn-runner";
import type { ConversationEntry } from "#storage/conversations";

function handle(forkId: string): ForkHandle {
  return { agent: "codex", forkId, rolloutPath: `/tmp/${forkId}.jsonl` };
}

function conversation(content: string): ConversationEntry {
  return {
    ts: "2026-07-17T00:00:00.000Z",
    agent: "codex",
    event: { type: "text", content },
  };
}

describe("ask session fork planning", () => {
  test("an eager fork replays with a fresh rollout from the inbox-time snapshot", async () => {
    const liveEntries = [conversation("visible when consumed")];
    const synthesizedSnapshots: ConversationEntry[][] = [];
    let syntheticId = 0;
    const plan = await createAskForkPlan({
      entries: liveEntries,
      forkNative: async () => handle("eager-native"),
      synthesize: (entries) => {
        synthesizedSnapshots.push(structuredClone(entries));
        // A provider writer is allowed to transform its input. That must not
        // affect the immutable snapshot retained for another replay.
        entries.length = 0;
        syntheticId++;
        return handle(`replay-${syntheticId}`);
      },
    });

    // The target advances while the ask waits/runs.
    liveEntries[0] = conversation("newer target state");
    liveEntries.push(conversation("also newer"));

    const replay = prepareInjectReplayAfterUserPreemption({
      topicId: "target",
      userId: "owner",
      prompt: "ask",
      origin: "caller",
      requestId: "request-1",
      silent: true,
      sessionId: plan.forkHandle.forkId,
      forkHandle: plan.forkHandle,
      prepareSession: plan.prepareSession,
    });

    expect(replay.sessionId).toBeUndefined();
    expect(replay.forkHandle).toBeUndefined();
    expect(replay.prepareSession).toBe(plan.prepareSession);
    expect((await replay.prepareSession!()).forkId).toBe("replay-1");
    expect((await replay.prepareSession!()).forkId).toBe("replay-2");
    expect(synthesizedSnapshots).toEqual([
      [conversation("visible when consumed")],
      [conversation("visible when consumed")],
    ]);
  });

  test("surfaces fallback failure after a native fork failure", async () => {
    const nativeErrors: unknown[] = [];
    await expect(
      createAskForkPlan({
        entries: [conversation("snapshot")],
        forkNative: async () => {
          throw new Error("native failed");
        },
        synthesize: () => {
          throw new Error("synthetic failed");
        },
        onNativeForkError: (error) => nativeErrors.push(error),
      }),
    ).rejects.toThrow("synthetic failed");

    expect(nativeErrors).toHaveLength(1);
    expect(nativeErrors[0]).toBeInstanceOf(Error);
  });
});
