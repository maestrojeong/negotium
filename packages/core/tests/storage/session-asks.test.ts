import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingAsk,
  createPendingAsk,
  listPendingAsksForCaller,
  markPendingAskState,
} from "#storage/session-asks";
import { configureStorageHost } from "#storage/storage-host";

const key = {
  userId: `pending-ask-test-${process.pid}`,
  from: "caller-topic",
  to: "target-topic",
};

let sessionAsksDir = "";
let restoreStorageHost: (() => void) | null = null;

beforeEach(() => {
  sessionAsksDir = join(tmpdir(), `negotium-session-asks-${process.pid}-${randomUUID()}`);
  restoreStorageHost = configureStorageHost({ sessionAsksDir });
});
afterEach(() => {
  restoreStorageHost?.();
  restoreStorageHost = null;
  rmSync(sessionAsksDir, { recursive: true, force: true });
});

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
    const dir = join(sessionAsksDir, legacyKey.userId);
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
      expect(readdirSync(dir)).toEqual([expect.stringMatching(/^v3-[a-f0-9]{64}\.pending$/)]);

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

  test("migrates v2 base64url filenames into bounded v3 hashes", () => {
    const v2Key = {
      userId: `pending-ask-v2-${process.pid}`,
      from: "v2-caller",
      to: "v2-target",
    };
    const dir = join(sessionAsksDir, v2Key.userId);
    const encoded = Buffer.from(JSON.stringify([v2Key.from, v2Key.to]), "utf8").toString(
      "base64url",
    );
    const v2Path = join(dir, `v2-${encoded}.pending`);
    const now = new Date().toISOString();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      v2Path,
      `${JSON.stringify({
        ...v2Key,
        requestId: "v2-request",
        state: "requested",
        createdAt: now,
        updatedAt: now,
      })}\n`,
    );

    const duplicate = createPendingAsk({ ...v2Key, requestId: "new-request" });
    expect(duplicate).toEqual({
      ok: false,
      existing: expect.objectContaining({ requestId: "v2-request" }),
      stale: false,
    });
    expect(existsSync(v2Path)).toBe(false);
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^v3-[a-f0-9]{64}\.pending$/)]);
  });

  test("hashes unsafe user ids and arbitrarily long ask keys into direct children", () => {
    const unsafeUserId = "../outside/user";
    const longFrom = `caller-${"x".repeat(8_000)}`;
    const longTo = `target-${"y".repeat(8_000)}`;
    const created = createPendingAsk({
      userId: unsafeUserId,
      from: longFrom,
      to: longTo,
      requestId: "bounded",
    });
    expect(created.ok).toBe(true);

    const userHash = createHash("sha256").update(unsafeUserId).digest("hex");
    const safeDir = join(sessionAsksDir, `sha256-${userHash}`);
    expect(readdirSync(safeDir)).toEqual([expect.stringMatching(/^v3-[a-f0-9]{64}\.pending$/)]);
    expect(listPendingAsksForCaller({ userId: unsafeUserId, from: longFrom })).toEqual([
      expect.objectContaining({ to: longTo, requestId: "bounded" }),
    ]);
    expect(clearPendingAsk({ userId: unsafeUserId, from: longFrom, to: longTo })).toBe(true);
  });

  test("hashes dot-dot user ids even when they contain no path separator", () => {
    const userId = "tenant..escape";
    expect(createPendingAsk({ ...key, userId, requestId: "dot-dot" }).ok).toBe(true);
    const userHash = createHash("sha256").update(userId).digest("hex");
    expect(readdirSync(join(sessionAsksDir, `sha256-${userHash}`))).toHaveLength(1);
  });

  test("does not migrate a compatibility record with a mismatched identity", () => {
    const mismatchedKey = { userId: "expected-user", from: "caller", to: "target" };
    const dir = join(sessionAsksDir, mismatchedKey.userId);
    const encoded = Buffer.from(
      JSON.stringify([mismatchedKey.from, mismatchedKey.to]),
      "utf8",
    ).toString("base64url");
    const v2Path = join(dir, `v2-${encoded}.pending`);
    const now = new Date().toISOString();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      v2Path,
      `${JSON.stringify({
        ...mismatchedKey,
        userId: "other-user",
        requestId: "foreign-request",
        state: "requested",
        createdAt: now,
        updatedAt: now,
      })}\n`,
    );

    expect(createPendingAsk({ ...mismatchedKey, requestId: "expected-request" }).ok).toBe(true);
    expect(existsSync(v2Path)).toBe(true);
  });
});
