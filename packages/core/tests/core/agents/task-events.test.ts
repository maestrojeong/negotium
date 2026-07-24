import { describe, expect, test } from "bun:test";
import { resolveTaskEventScope, type TaskEventHost, withTaskSnapshots } from "#agents/task-events";
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

  test("uses a caller-owned task scope resolver", () => {
    expect(
      resolveTaskEventScope(opts({ userId: "host-user", session: "Host topic" }), {
        readTasks: () => [],
        taskFileMtimeNs: () => BigInt(0),
        taskScopeKey: () => "host-scope",
      }),
    ).toEqual({ userId: "host-user", scopeKey: "host-scope" });
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
  test("emits an initial empty snapshot to clear stale persisted panels", async () => {
    const host: TaskEventHost = {
      readTasks: () => [],
      taskFileMtimeNs: () => BigInt(0),
      taskScopeKey: ({ topicId, session }) => topicId ?? session,
    };
    const events = await collect(
      withTaskSnapshots(
        fakeStream([{ type: "result", content: "done", stopReason: "end_turn" }]),
        { userId: "caller", scopeKey: "topic" },
        host,
      ),
    );
    expect(events).toEqual([
      { type: "tasks", tasks: [] },
      { type: "result", content: "done", stopReason: "end_turn" },
    ]);
  });

  test("isolates snapshot state through the caller-owned host", async () => {
    let mtime = BigInt(0);
    const host = {
      readTasks: () => [{ id: "host", subject: "host task", status: "pending" as const }],
      taskFileMtimeNs: () => mtime,
      taskScopeKey: () => "host-scope",
    };
    const events = await collect(
      withTaskSnapshots(
        fakeStream([
          () => {
            mtime = BigInt(1);
          },
          { type: "result", content: "done", stopReason: "end_turn" },
        ]),
        { userId: "host-user", scopeKey: "host-scope" },
        host,
      ),
    );
    expect(events).toEqual([
      { type: "result", content: "done", stopReason: "end_turn" },
      { type: "tasks", tasks: [{ id: "host", subject: "host task", status: "pending" }] },
    ]);
  });

  test("keeps snapshots inside the caller-owned host", async () => {
    let mtime = BigInt(1);
    const host: TaskEventHost = {
      taskScopeKey: ({ topicId, session }) => topicId ?? session,
      taskFileMtimeNs: () => mtime,
      readTasks: () => [{ id: "host", subject: "isolated", status: "pending" }],
    };
    const events = await collect(
      withTaskSnapshots(
        fakeStream([
          () => {
            mtime = BigInt(2);
          },
          { type: "tool_result", toolUseId: "t1", content: "" },
        ]),
        { userId: "caller", scopeKey: "topic" },
        host,
      ),
    );
    expect(events).toEqual([
      { type: "tool_result", toolUseId: "t1", content: "" },
      { type: "tasks", tasks: [{ id: "host", subject: "isolated", status: "pending" }] },
    ]);
  });

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
      "tasks",
      "tool_use",
      "tool_result",
      "tasks",
      "result",
    ]);
    const tasksEvent = events[3] as Extract<UnifiedEvent, { type: "tasks" }>;
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
    expect(events.map((event) => event.type)).toEqual(["tasks", "result", "tasks"]);
  });
});
