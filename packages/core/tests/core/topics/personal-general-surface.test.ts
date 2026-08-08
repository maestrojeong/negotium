import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deleteTopic, getManagerTopicForUser } from "#storage/api-topics";
import { ensurePersonalGeneral } from "#topics/personal-general";

const created: string[] = [];

afterEach(() => {
  for (const id of created.splice(0)) deleteTopic(id);
});

describe("personal General is per surface", () => {
  test("each adapter gets its own manager room for the same user", () => {
    const userId = `pg-surface-${randomUUID()}`;
    const terminal = ensurePersonalGeneral(userId, "terminal");
    const telegram = ensurePersonalGeneral(userId, "telegram");
    created.push(terminal.id, telegram.id);

    // Returning one surface's manager room to another adapter let that adapter
    // bind to — and then reclassify — a room the first surface still lists.
    expect(telegram.id).not.toBe(terminal.id);
    expect(terminal.surface).toBe("terminal");
    expect(telegram.surface).toBe("telegram");
    expect(terminal.title).toBe("General");
    expect(telegram.title).toBe("General");
  });

  test("the same surface reuses its room instead of making a second one", () => {
    const userId = `pg-reuse-${randomUUID()}`;
    const first = ensurePersonalGeneral(userId, "terminal");
    const again = ensurePersonalGeneral(userId, "terminal");
    created.push(first.id);

    expect(again.id).toBe(first.id);
  });

  test("lookup is scoped, and unscoped lookup still finds one", () => {
    const userId = `pg-lookup-${randomUUID()}`;
    const otium = ensurePersonalGeneral(userId, "otium");
    created.push(otium.id);

    expect(getManagerTopicForUser(userId, "otium")?.id).toBe(otium.id);
    expect(getManagerTopicForUser(userId, "terminal")).toBeNull();
    expect(getManagerTopicForUser(userId)?.id).toBe(otium.id);
  });
});
