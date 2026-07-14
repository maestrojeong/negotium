import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deleteApiTopicConfig, getApiTopicConfig } from "#storage/api-topic-config";
import { deleteTopic, getTopic, upsertTopic } from "#storage/api-topics";
import {
  ensurePersonalGeneral,
  PERSONAL_GENERAL_DESCRIPTION,
  resolvePersonalTopicId,
} from "#topics/personal-general";

const createdTopicIds: string[] = [];

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) {
    deleteApiTopicConfig(topicId);
    deleteTopic(topicId, { allowManager: true });
  }
});

describe("personal General", () => {
  test("provisions one private owner-only manager room per user", () => {
    const firstUserId = `personal-general-a-${randomUUID()}`;
    const secondUserId = `personal-general-b-${randomUUID()}`;

    const first = ensurePersonalGeneral(firstUserId);
    const firstAgain = ensurePersonalGeneral(firstUserId);
    const second = ensurePersonalGeneral(secondUserId);
    createdTopicIds.push(first.id, second.id);

    expect(first.id).toBe(firstAgain.id);
    expect(first.id).not.toBe("general");
    expect(second.id).not.toBe(first.id);
    expect(first).toMatchObject({
      title: "General",
      description: PERSONAL_GENERAL_DESCRIPTION,
      kind: "manager",
      agent: "maestro",
      aiMode: "always",
      participants: [{ userId: firstUserId, role: "owner" }],
    });
    expect(second.participants).toEqual([{ userId: secondUserId, role: "owner" }]);
    expect(getApiTopicConfig(first.id)).toMatchObject({
      model: "deepseek-pro",
      modelLocked: true,
    });
  });

  test("updates only the retired misleading default description", () => {
    const userId = `personal-general-description-${randomUUID()}`;
    const created = ensurePersonalGeneral(userId);
    createdTopicIds.push(created.id);
    created.description =
      "나만의 개인 공간이에요. 대화와 AI 작업은 다른 사용자에게 공개되지 않습니다.";
    upsertTopic(created);

    expect(ensurePersonalGeneral(userId).description).toBe(PERSONAL_GENERAL_DESCRIPTION);

    const customized = ensurePersonalGeneral(userId);
    customized.description = "My custom manager description";
    upsertTopic(customized);
    expect(ensurePersonalGeneral(userId).description).toBe("My custom manager description");
  });

  test("maps the legacy fixed id to the caller's private room", () => {
    const userId = `personal-general-alias-${randomUUID()}`;
    const resolved = resolvePersonalTopicId("general", userId);
    createdTopicIds.push(resolved);

    expect(resolved).not.toBe("general");
    expect(getTopic(resolved)?.participants).toEqual([{ userId, role: "owner" }]);
    expect(resolvePersonalTopicId("some-topic", userId)).toBe("some-topic");
  });
});
