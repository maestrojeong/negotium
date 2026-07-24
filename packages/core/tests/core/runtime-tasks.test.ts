import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { upsertTaskPanelMessage } from "#runtime/tasks";
import { deleteMessagesForTopic, getApiMessage, listApiMessages } from "#storage/api-messages";

test("an empty task snapshot removes every historical task panel", () => {
  const topicId = `task-panel-${randomUUID()}`;
  const firstQueryId = `query-${randomUUID()}`;
  const secondQueryId = `query-${randomUUID()}`;

  try {
    const firstText = upsertTaskPanelMessage(
      topicId,
      firstQueryId,
      [{ id: "1", subject: "first", status: "completed" }],
      null,
    );
    const secondText = upsertTaskPanelMessage(
      topicId,
      secondQueryId,
      [{ id: "2", subject: "second", status: "pending" }],
      null,
    );

    expect(firstText).not.toBeNull();
    expect(secondText).not.toBeNull();
    expect(upsertTaskPanelMessage(topicId, secondQueryId, [], secondText)).toBeNull();

    expect(getApiMessage(topicId, `tasks-${firstQueryId}`)?.deleted).toBe(true);
    expect(getApiMessage(topicId, `tasks-${secondQueryId}`)?.deleted).toBe(true);
    expect(listApiMessages(topicId).page).toEqual([]);
  } finally {
    deleteMessagesForTopic(topicId);
  }
});
