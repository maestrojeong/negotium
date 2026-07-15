import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_ASKS_DIR } from "#platform/config";
import {
  clearPendingAsk,
  createPendingAsk,
  listPendingAsksForCaller,
  markPendingAskState,
} from "#storage/session-asks";

const key = {
  userId: `pending-ask-test-${process.pid}`,
  from: "caller-topic",
  to: "target-topic",
};

function clearTestAsk(): void {
  clearPendingAsk(key);
}

beforeEach(clearTestAsk);
afterEach(clearTestAsk);

describe("pending ask storage", () => {
  test("round-trips remote and delimiter-bearing ask keys", () => {
    const remoteKey = {
      userId: key.userId,
      from: "caller___topic/with/slash",
      to: "worker/회의___방",
    };
    const created = createPendingAsk({ ...remoteKey, requestId: "r-remote" });

    expect(created.ok).toBe(true);
    expect(listPendingAsksForCaller({ userId: remoteKey.userId, from: remoteKey.from })).toEqual([
      expect.objectContaining({
        from: remoteKey.from,
        to: remoteKey.to,
        requestId: "r-remote",
      }),
    ]);
    expect(clearPendingAsk({ ...remoteKey, requestId: "r-remote" })).toBe(true);
  });

  test("migrates a live legacy request before create, mark, and clear", () => {
    const legacyKey = {
      userId: `pending-ask-legacy-${process.pid}`,
      from: "legacy-caller",
      to: "legacy-target___suffix",
    };
    const dir = join(SESSION_ASKS_DIR, legacyKey.userId);
    const legacyPath = join(dir, `${legacyKey.from}___${legacyKey.to}.pending`);
    const now = new Date().toISOString();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      legacyPath,
      `${JSON.stringify({
        ...legacyKey,
        requestId: "legacy-request",
        state: "requested",
        createdAt: now,
        updatedAt: now,
      })}\n`,
    );

    try {
      const duplicate = createPendingAsk({ ...legacyKey, requestId: "new-request" });
      expect(duplicate).toEqual({
        ok: false,
        existing: expect.objectContaining({ requestId: "legacy-request" }),
        stale: false,
      });
      expect(existsSync(legacyPath)).toBe(false);
      expect(readdirSync(dir).some((name) => name.startsWith("v2-"))).toBe(true);

      expect(
        markPendingAskState({
          ...legacyKey,
          requestId: "legacy-request",
          state: "reply_ready",
        }),
      ).toEqual(expect.objectContaining({ state: "reply_ready" }));
      expect(clearPendingAsk({ ...legacyKey, requestId: "legacy-request" })).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
