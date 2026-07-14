import { describe, expect, test } from "bun:test";
import { resolveTaskEventScope, withTaskSnapshots } from "#agents/task-events";
import { writeTasks } from "#storage/tasks";
import type { AgentQueryOptions, UnifiedEvent } from "#types";

const baseOpts = {
  agent: "claude",
  prompt: "p",
  cwd: "/tmp",
  systemPrompt: "s",
} as const;

function opts(extra: Partial<AgentQueryOptions>): AgentQueryOptions {
  return { ...baseOpts, ...extra } as AgentQueryOptions;
}

describe("resolveTaskEventScope", () => {
  test("topic queries key on topic id when present", () => {
    expect(
      resolveTaskEventScope(opts({ userId: "1", session: "Research", topicId: "t-1" })),
    ).toEqual({
      userId: "1",
      scopeKey: "t-1",
    });
  });

  test("dm/ephemeral normalize to the DM store key", () => {
    expect(
      resolveTaskEventScope(opts({ userId: "1", session: "__dm__", sessionType: "dm" })),
    ).toEqual({
      userId: "1",
      scopeKey: "dm",
    });
    expect(
      resolveTaskEventScope(opts({ userId: "1", session: "archiver", sessionType: "ephemeral" })),
    ).toEqual({ userId: "1", scopeKey: "dm" });
  });

  test("manager scope defaults to the shared General topic id", () => {
    expect(
      resolveTaskEventScope(opts({ userId: "1", session: "General", sessionType: "manager" })),
    ).toEqual({
      userId: "1",
      scopeKey: "general",
    });
  });

  test("silent and context-less queries get no scope", () => {
    expect(resolveTaskEventScope(opts({ userId: "1", session: "t", silent: true }))).toBeNull();
    expect(resolveTaskEventScope(opts({ session: "t" }))).toBeNull();
    expect(resolveTaskEventScope(opts({ userId: "1" }))).toBeNull();
  });
});

async function* fakeStream(
  events: Array<UnifiedEvent | (() => void)>,
): AsyncGenerator<UnifiedEvent> {
  for (const event of events) {
    if (typeof event === "function") event();
    else yield event;
  }
}

async function collect(gen: AsyncGenerator<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const out: UnifiedEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe("withTaskSnapshots", () => {
  test("injects a tasks snapshot after a tool_result that changed the store", async () => {
    const scope = { userId: "50", scopeKey: "bridge-a" };
    const events = await collect(
      withTaskSnapshots(
        fakeStream([
          { type: "tool_use", name: "mcp__task__task_create", input: {} },
          () => writeTasks("50", "bridge-a", [{ id: "1", subject: "a", status: "pending" }]),
          { type: "tool_result", toolUseId: "t1", content: "" },
          { type: "result", content: "done", stopReason: "end_turn" },
        ]),
        scope,
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      "tool_use",
      "tool_result",
      "tasks",
      "result",
    ]);
    const tasksEvent = events[2] as Extract<UnifiedEvent, { type: "tasks" }>;
    expect(tasksEvent.tasks).toEqual([{ id: "1", subject: "a", status: "pending" }]);
  });

  test("does not emit when the store never changes", async () => {
    writeTasks("51", "bridge-b", [{ id: "1", subject: "old", status: "pending" }]);
    const events = await collect(
      withTaskSnapshots(
        fakeStream([
          { type: "tool_result", toolUseId: "t1", content: "" },
          { type: "result", content: "done", stopReason: "end_turn" },
        ]),
        { userId: "51", scopeKey: "bridge-b" },
      ),
    );
    expect(events.map((event) => event.type)).toEqual(["tool_result", "result"]);
  });

  test("checks the store on terminal result too", async () => {
    const events = await collect(
      withTaskSnapshots(
        fakeStream([
          () => writeTasks("52", "bridge-c", [{ id: "1", subject: "a", status: "pending" }]),
          { type: "result", content: "done", stopReason: "end_turn" },
        ]),
        { userId: "52", scopeKey: "bridge-c" },
      ),
    );
    expect(events.map((event) => event.type)).toEqual(["result", "tasks"]);
  });
});
