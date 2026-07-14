import { WsHub } from "#bus";
import { appendApiMessage, getApiMessage, updateApiMessageText } from "#storage/api-messages";
import type { TaskSnapshot } from "#types";
import type { MessageDto } from "#types/api";

/** Render a task snapshot into the compact checklist Otium shows live. */
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

export function upsertTaskPanelMessage(
  topicId: string,
  queryId: string,
  tasks: TaskSnapshot[],
  lastRenderedText: string | null,
): string | null {
  if (tasks.length === 0) return lastRenderedText;
  const text = renderTaskPanel(tasks);
  if (text === lastRenderedText) return lastRenderedText;

  const hub = WsHub.get();
  const messageId = taskPanelMessageId(queryId);
  const existing = getApiMessage(topicId, messageId);
  if (existing && !existing.deleted) {
    const editedAt = new Date().toISOString();
    const updated = updateApiMessageText(topicId, messageId, text, editedAt);
    if (updated) {
      hub.broadcastMessageUpdated(topicId, messageId, { text, editedAt });
      return text;
    }
  }

  const createdAt = new Date().toISOString();
  const message: MessageDto = {
    id: messageId,
    topicId,
    authorId: "system",
    text,
    createdAt,
  };
  appendApiMessage(message, { notify: false });
  hub.broadcastMessage(topicId, message);
  return text;
}
