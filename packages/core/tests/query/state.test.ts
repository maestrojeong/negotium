import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USERS_LOG_DIR } from "#platform/config";
import { clearQueryState, writeQueryState } from "#query/state";
import { sanitizeId } from "#security/sanitize";
import type { QueryState } from "#types";

const users: string[] = [];

function stateDir(userId: string): string {
  return join(USERS_LOG_DIR, userId, "active-queries");
}

function statePath(userId: string, topicId: string): string {
  return join(stateDir(userId), `${sanitizeId(topicId)}.json`);
}

afterEach(() => {
  for (const userId of users.splice(0)) {
    rmSync(join(USERS_LOG_DIR, userId), { recursive: true, force: true });
  }
});

describe("active query state", () => {
  test("same-title topics keep independent ID-addressed state", () => {
    const userId = `query-state-${randomUUID()}`;
    users.push(userId);
    const agentTopicId = randomUUID();
    const channelTopicId = randomUUID();

    writeQueryState(userId, agentTopicId, "Roadmap", "agent work");
    writeQueryState(userId, channelTopicId, "Roadmap", "channel work");

    const agent = JSON.parse(readFileSync(statePath(userId, agentTopicId), "utf8")) as QueryState;
    const channel = JSON.parse(
      readFileSync(statePath(userId, channelTopicId), "utf8"),
    ) as QueryState;
    expect(agent).toMatchObject({
      topicId: agentTopicId,
      topicName: "Roadmap",
      task: "agent work",
    });
    expect(channel).toMatchObject({
      topicId: channelTopicId,
      topicName: "Roadmap",
      task: "channel work",
    });

    clearQueryState(userId, agentTopicId, "Roadmap");
    expect(existsSync(statePath(userId, agentTopicId))).toBe(false);
    expect(existsSync(statePath(userId, channelTopicId))).toBe(true);
  });

  test("clear removes a legacy title-addressed state file", () => {
    const userId = `query-state-${randomUUID()}`;
    users.push(userId);
    mkdirSync(stateDir(userId), { recursive: true });
    const legacyPath = join(stateDir(userId), "Legacy Room.json");
    writeFileSync(legacyPath, JSON.stringify({ since: new Date().toISOString() }));

    clearQueryState(userId, randomUUID(), "Legacy Room");

    expect(existsSync(legacyPath)).toBe(false);
  });
});
