import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errMsg } from "#platform/error";
import {
  createTasks,
  deleteTasks,
  readTasks,
  renderTaskList,
  type StoredTask,
  TASK_STATUS_VALUES,
  taskScopeKey,
  updateTasks,
  writeTasks,
} from "#storage/tasks";
import { mcpError, mcpOk } from "../mcp-helpers";

export interface TaskMcpContext {
  userId: string;
  topic: string;
  topicId?: string;
}

export interface TaskMcpHost {
  readTasks(userId: string, scopeKey: string): StoredTask[];
  writeTasks(userId: string, scopeKey: string, tasks: StoredTask[]): void;
}

export const defaultTaskMcpHost: TaskMcpHost = {
  readTasks,
  writeTasks,
};

export function createTaskMcpServer(
  context: TaskMcpContext,
  host: TaskMcpHost = defaultTaskMcpHost,
): McpServer {
  const scopeKey = context.topic
    ? taskScopeKey({ topicId: context.topicId, session: context.topic })
    : "";
  const server = new McpServer({ name: "task", version: "1.0.0" });
  const requireContext = (): ReturnType<typeof mcpError> | null => {
    if (!context.userId || !scopeKey) {
      return mcpError("Error: missing userId/topic context.");
    }
    return null;
  };
  const statusEnum = z.enum(TASK_STATUS_VALUES);

  server.tool(
    "task_create",
    "Add one or more tasks to this topic's shared Otium task list. Use this instead of provider-native todo/task tools.",
    {
      tasks: z
        .array(
          z.object({
            subject: z.string().min(1).describe("Short imperative task description"),
            active_form: z
              .string()
              .optional()
              .describe("Label to show while the task is in progress"),
            blocked_by: z.array(z.string()).optional().describe("Task ids blocking this task"),
            owner: z.string().optional().describe("Owner/agent label for multi-agent work"),
          }),
        )
        .min(1),
    },
    async ({ tasks: inputs }) => {
      const guard = requireContext();
      if (guard) return guard;
      try {
        const current = host.readTasks(context.userId, scopeKey);
        const { tasks, created } = createTasks(
          current,
          inputs.map((task) => ({
            subject: task.subject,
            activeForm: task.active_form,
            blockedBy: task.blocked_by,
            owner: task.owner,
          })),
        );
        host.writeTasks(context.userId, scopeKey, tasks);
        const ids = created.map((task) => `#${task.id}`).join(", ");
        return mcpOk(`${created.length} task(s) created (${ids})\n\n${renderTaskList(tasks)}`);
      } catch (error) {
        return mcpError(`task_create failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "task_update",
    "Update task status/content in this topic's shared Otium task list. Batch related status changes in one call.",
    {
      updates: z
        .array(
          z.object({
            id: z.string().describe("Target task id"),
            status: statusEnum.optional().describe("New status"),
            subject: z.string().min(1).optional().describe("Replacement task description"),
            active_form: z
              .string()
              .optional()
              .describe("Replacement in-progress label; empty string clears it"),
            blocked_by: z.array(z.string()).optional().describe("Replacement blocker id list"),
            owner: z.string().optional().describe("Replacement owner; empty string clears it"),
          }),
        )
        .min(1),
    },
    async ({ updates }) => {
      const guard = requireContext();
      if (guard) return guard;
      try {
        const current = host.readTasks(context.userId, scopeKey);
        const { tasks, missing } = updateTasks(
          current,
          updates.map((update) => ({
            id: update.id,
            status: update.status,
            subject: update.subject,
            activeForm: update.active_form,
            blockedBy: update.blocked_by,
            owner: update.owner,
          })),
        );
        host.writeTasks(context.userId, scopeKey, tasks);
        const warning = missing.length > 0 ? `\nMissing ids ignored: ${missing.join(", ")}` : "";
        return mcpOk(`${renderTaskList(tasks)}${warning}`);
      } catch (error) {
        return mcpError(`task_update failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool("task_list", "Read this topic's shared Otium task list.", {}, async () => {
    const guard = requireContext();
    if (guard) return guard;
    try {
      return mcpOk(renderTaskList(host.readTasks(context.userId, scopeKey)));
    } catch (error) {
      return mcpError(`task_list failed: ${errMsg(error)}`);
    }
  });

  server.tool(
    "task_get",
    "Read one task from this topic's shared Otium task list as JSON.",
    { id: z.string().describe("Task id") },
    async ({ id }) => {
      const guard = requireContext();
      if (guard) return guard;
      try {
        const task = host.readTasks(context.userId, scopeKey).find((entry) => entry.id === id);
        if (!task) return mcpError(`Task #${id} not found.`);
        return mcpOk(JSON.stringify(task, null, 2));
      } catch (error) {
        return mcpError(`task_get failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "task_delete",
    "Delete tasks from this topic's shared Otium task list. Use all=true only when starting a new plan.",
    {
      ids: z.array(z.string()).optional().describe("Task ids to delete"),
      all: z.boolean().optional().describe("Delete the whole list"),
    },
    async ({ ids, all }) => {
      const guard = requireContext();
      if (guard) return guard;
      if (!all && (!ids || ids.length === 0)) return mcpError("Provide ids or all=true.");
      try {
        const current = host.readTasks(context.userId, scopeKey);
        const { tasks, removed } = deleteTasks(current, { ids, all });
        host.writeTasks(context.userId, scopeKey, tasks);
        return mcpOk(`${removed} task(s) deleted\n\n${renderTaskList(tasks)}`);
      } catch (error) {
        return mcpError(`task_delete failed: ${errMsg(error)}`);
      }
    },
  );

  return server;
}
