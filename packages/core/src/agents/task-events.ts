import { readTasks, taskFileMtimeNs, taskScopeKey } from "#storage/tasks";
import type { AgentQueryOptions, UnifiedEvent } from "#types";

export interface TaskEventScope {
  userId: string;
  scopeKey: string;
}

export function resolveTaskEventScope(opts: AgentQueryOptions): TaskEventScope | null {
  if (opts.silent) return null;
  if (!opts.userId) return null;
  if (opts.sessionType === "dm" || opts.sessionType === "ephemeral") {
    return { userId: opts.userId, scopeKey: "dm" };
  }
  if (opts.sessionType === "manager") {
    return { userId: opts.userId, scopeKey: opts.topicId ?? "general" };
  }
  if (!opts.session) return null;
  return {
    userId: opts.userId,
    scopeKey: taskScopeKey({ topicId: opts.topicId, session: opts.session }),
  };
}

/**
 * The task MCP server runs as a child process of the agent SDK. Its writes do
 * not appear in the provider stream, so after tool results and terminal
 * results we stat the shared store and inject the full task snapshot when it
 * changed.
 */
export async function* withTaskSnapshots(
  inner: AsyncGenerator<UnifiedEvent>,
  scope: TaskEventScope,
): AsyncGenerator<UnifiedEvent> {
  let lastMtime = taskFileMtimeNs(scope.userId, scope.scopeKey);
  for await (const event of inner) {
    yield event;
    if (event.type !== "tool_result" && event.type !== "result") continue;
    const mtime = taskFileMtimeNs(scope.userId, scope.scopeKey);
    if (mtime === lastMtime) continue;
    lastMtime = mtime;
    yield { type: "tasks", tasks: readTasks(scope.userId, scope.scopeKey) };
  }
}
