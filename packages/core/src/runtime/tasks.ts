import { WsHub } from "#bus";
import { renderTaskPanel, taskPanelMessageId } from "#runtime/task-format";
import { appendApiMessage, getApiMessage, updateApiMessageText } from "#storage/api-messages";
import type { TaskSnapshot } from "#types";
import type { MessageDto } from "#types/api";

export { renderTaskPanel, taskPanelMessageId } from "#runtime/task-format";

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
