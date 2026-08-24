import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { NODE_LOCAL_USER_ID } from "#platform/constants";
import { getActiveConversationPath, getConversationPath } from "#storage/conversations";

/**
 * Every person gets a private General, and a manager room is the one kind
 * exempt from title uniqueness — so the title alone cannot key its log.
 */
describe("private General conversation paths", () => {
  test("two people's General rooms do not share one transcript", () => {
    const mine = getConversationPath("otium-hosted-usr_a", "General");
    const theirs = getConversationPath("otium-hosted-usr_b", "General");
    expect(mine).not.toBe(theirs);
    expect(basename(mine)).toBe("general.otium-hosted-usr_a.jsonl");
  });

  test("the node's own principal keeps the unqualified path", () => {
    expect(basename(getConversationPath(NODE_LOCAL_USER_ID, "General"))).toBe("general.jsonl");
  });

  test("the active projection follows the raw log", () => {
    expect(basename(getActiveConversationPath("otium-hosted-usr_a", "General"))).toBe(
      "general.otium-hosted-usr_a.active.jsonl",
    );
  });

  test("uniquely titled rooms are untouched, whoever owns them", () => {
    expect(basename(getConversationPath("otium-hosted-usr_a", "worker-room"))).toBe(
      "worker-room.jsonl",
    );
    expect(getConversationPath("otium-hosted-usr_a", "worker-room")).toBe(
      getConversationPath(NODE_LOCAL_USER_ID, "worker-room"),
    );
  });
});
