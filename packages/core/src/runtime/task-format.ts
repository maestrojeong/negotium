import type { TaskSnapshot } from "#types";

/** Render a task snapshot into the compact checklist shown by Otium-compatible hosts. */
export function renderTaskPanel(tasks: TaskSnapshot[]): string {
  const done = tasks.filter((task) => task.status === "completed").length;
  const lines = [`📋 Tasks (${done}/${tasks.length})`];
  for (const task of tasks) {
    const mark = task.status === "completed" ? "✓" : task.status === "in_progress" ? "→" : "☐";
    const deps =
      task.blockedBy && task.blockedBy.length > 0 ? ` (#${task.blockedBy.join(", #")} 대기)` : "";
    lines.push(`  ${mark} ${task.subject}${deps}`);
  }
  return lines.join("\n");
}

export function taskPanelMessageId(queryId: string): string {
  return `tasks-${queryId}`;
}
