import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storage from "#storage/storage-public";

describe("public storage facade", () => {
  test("exports direct APIs and collision-safe module namespaces", () => {
    expect(storage.configureStorageHost).toBeFunction();
    expect(storage.resetStorageHost).toBeFunction();
    expect(storage.db).toBeDefined();
    expect(storage.getTopic).toBeFunction();
    expect(storage.replaceConversationStrict).toBeFunction();
    expect(storage.resolveTopicBrief).toBeFunction();
    expect(storage.deletePendingAsksForTopic).toBeFunction();
    expect(storage.tokenStatsFileId).toBeFunction();
    expect(storage.apiTopics.getTopicByName).toBe(storage.getTopicByName);
    expect(storage.forum.getTopicByName).toBeFunction();
    expect(storage.sessionAsks.createPendingAsk).toBe(storage.createPendingAsk);
  });

  test("exposes durable ask-user-gate and runtime-process-lease storage for embedding hosts", () => {
    expect(storage.prepareAskUserGate).toBeFunction();
    expect(storage.claimAskUserGateAndSelect).toBeFunction();
    expect(storage.cancelAskUserGate).toBeFunction();
    expect(storage.quarantineAskUserGate).toBeFunction();
    expect(storage.quarantineForeignAskUserGates).toBeFunction();
    expect(storage.askUserGates.prepareAskUserGate).toBe(storage.prepareAskUserGate);

    expect(storage.acquireRuntimeProcessLease).toBeFunction();
    expect(storage.listRuntimeProcessLeases).toBeFunction();
    expect(storage.isRuntimeProcessLeaseAlive).toBeFunction();
    expect(storage.removeDeadRuntimeProcessLeases).toBeFunction();
    expect(storage.runtimeProcessLeases.acquireRuntimeProcessLease).toBe(
      storage.acquireRuntimeProcessLease,
    );
  });

  test("importing the facade does not create fallback storage paths", () => {
    const parent = mkdtempSync(join(tmpdir(), "negotium-storage-import-"));
    const stateDir = join(parent, "state-that-must-stay-absent");
    try {
      execFileSync(process.execPath, ["-e", 'await import("./src/storage/storage-public.ts");'], {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          NEGOTIUM_STATE_DIR: stateDir,
          NEGOTIUM_DATA_DIR: "",
          NEGOTIUM_LOG_DIR: "",
          NEGOTIUM_RUN_DIR: "",
          NEGOTIUM_WORKSPACE_DIR: "",
          SESSIONS_DB_PATH: "",
        },
        stdio: "pipe",
      });
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
