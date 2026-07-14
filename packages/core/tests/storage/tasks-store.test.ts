import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  createTasks,
  deleteTasks,
  getTaskFilePath,
  readTasks,
  renderTaskList,
  type StoredTask,
  taskFileMtimeNs,
  taskScopeKey,
  updateTasks,
  writeTasks,
} from "#storage/tasks";

describe("task store paths", () => {
  test("prefers topic id over display title for stable topic scope", () => {
    expect(taskScopeKey({ topicId: "topic-123", session: "Research" })).toBe("topic-123");
  });

  test("sanitizes scope keys into a per-user JSON file", () => {
    const path = getTaskFilePath("user-1", "Topic / A");
    expect(path.endsWith("/tasks/user-1/Topic___A.json")).toBe(true);
  });

  test("rejects unsafe user id path components", () => {
    expect(() => getTaskFilePath("../evil", "topic")).toThrow();
  });
});

describe("task store read/write", () => {
  test("missing file reads as empty list", () => {
    expect(readTasks("u-1", "never-written")).toEqual([]);
    expect(taskFileMtimeNs("u-1", "never-written")).toBeNull();
  });

  test("writeTasks persists and readTasks returns the same list", () => {
    const tasks: StoredTask[] = [
      { id: "1", subject: "first", status: "pending" },
      { id: "2", subject: "second", status: "in_progress", blockedBy: ["1"], owner: "codex" },
    ];
    writeTasks("u-2", "roundtrip", tasks);
    expect(existsSync(getTaskFilePath("u-2", "roundtrip"))).toBe(true);
    expect(readTasks("u-2", "roundtrip")).toEqual(tasks);
    expect(taskFileMtimeNs("u-2", "roundtrip")).toBeGreaterThan(BigInt(0));
  });

  test("topic ids prevent same-title collisions", () => {
    writeTasks("u-3", "topic-a", [{ id: "1", subject: "a", status: "pending" }]);
    writeTasks("u-3", "topic-b", [{ id: "1", subject: "b", status: "pending" }]);
    expect(readTasks("u-3", "topic-a")[0]?.subject).toBe("a");
    expect(readTasks("u-3", "topic-b")[0]?.subject).toBe("b");
  });
});

describe("task mutations", () => {
  test("creates pending tasks with stable sequential ids", () => {
    const { tasks, created } = createTasks([], [{ subject: "a" }, { subject: "b" }]);
    expect(tasks.map((task) => task.id)).toEqual(["1", "2"]);
    expect(created.every((task) => task.status === "pending")).toBe(true);
  });

  test("updates fields by id and reports missing ids", () => {
    const base: StoredTask[] = [
      { id: "1", subject: "a", status: "pending", blockedBy: ["2"] },
      { id: "2", subject: "b", status: "in_progress" },
    ];
    const { tasks, missing } = updateTasks(base, [
      { id: "2", status: "completed", owner: "claude" },
      { id: "99", status: "completed" },
      { id: "1", blockedBy: [] },
    ]);
    expect(tasks[0]?.blockedBy).toBeUndefined();
    expect(tasks[1]).toMatchObject({ status: "completed", owner: "claude" });
    expect(missing).toEqual(["99"]);
    expect(base[1]?.status).toBe("in_progress");
  });

  test("deletes by id or all", () => {
    const base: StoredTask[] = [
      { id: "1", subject: "a", status: "pending" },
      { id: "2", subject: "b", status: "completed" },
    ];
    expect(deleteTasks(base, { ids: ["1"] })).toEqual({
      tasks: [{ id: "2", subject: "b", status: "completed" }],
      removed: 1,
    });
    expect(deleteTasks(base, { all: true })).toEqual({ tasks: [], removed: 2 });
  });

  test("renders model-facing task list", () => {
    const text = renderTaskList([
      { id: "1", subject: "done", status: "completed" },
      { id: "2", subject: "doing", status: "in_progress", blockedBy: ["1"], owner: "sub" },
    ]);
    expect(text).toContain("Tasks (1/2 완료)");
    expect(text).toContain("[x] #1 done");
    expect(text).toContain("[->] #2 doing (blocked by #1) @sub");
  });
});
