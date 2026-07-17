import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalAiName, setGlobalAiName } from "#storage/app-settings";
import "#storage/api-messages";
import "#storage/api-topics";
import { flushSessionCache, getAllUserIds } from "#storage/forum/index";
import { db } from "#storage/forum-db";
import { createPendingAsk } from "#storage/session-asks";
import {
  configureStorageHost,
  resolveStorageDataDir,
  resolveStorageLogDir,
  resolveStorageSessionAsksDir,
  resolveStorageWorkspaceDir,
} from "#storage/storage-host";
import { getTaskFilePath, writeTasks } from "#storage/tasks";
import { getStats, recordUsage } from "#storage/token-stats";
import { getSharedWikiDir } from "#storage/wiki";

const tempDirs: string[] = [];
const disposers: Array<() => void> = [];
const databases: Database[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "negotium-storage-host-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const database of databases.splice(0)) database.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("storage host", () => {
  test("resolves injected paths lazily and restores nested hosts", () => {
    const root = tempRoot();
    const first = {
      dataDir: join(root, "data-a"),
      logDir: join(root, "logs-a"),
      sessionAsksDir: join(root, "asks-a"),
      workspaceDir: join(root, "workspace-a"),
    };
    const disposeFirst = configureStorageHost(first);
    disposers.push(disposeFirst);

    expect(resolveStorageDataDir()).toBe(first.dataDir);
    expect(resolveStorageLogDir()).toBe(first.logDir);
    expect(resolveStorageSessionAsksDir()).toBe(first.sessionAsksDir);
    expect(resolveStorageWorkspaceDir()).toBe(first.workspaceDir);
    expect(getSharedWikiDir()).toBe(join(first.workspaceDir, "wiki"));
    expect(existsSync(first.dataDir)).toBe(false);

    const secondDataDir = join(root, "data-b");
    const disposeSecond = configureStorageHost({ dataDir: secondDataDir });
    disposers.push(disposeSecond);
    expect(resolveStorageDataDir()).toBe(secondDataDir);
    expect(resolveStorageLogDir()).toBe(first.logDir);

    disposeSecond();
    disposers.pop();
    expect(resolveStorageDataDir()).toBe(first.dataDir);
  });

  test("routes file-backed stores through the configured host", () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const logDir = join(root, "logs");
    const sessionAsksDir = join(root, "asks");
    disposers.push(configureStorageHost({ dataDir, logDir, sessionAsksDir }));

    writeTasks("host-user", "host-topic", []);
    expect(getTaskFilePath("host-user", "host-topic").startsWith(dataDir)).toBe(true);

    setGlobalAiName("Hostium");
    expect(getGlobalAiName()).toBe("Hostium");
    expect(existsSync(join(dataDir, "otium-settings.json"))).toBe(true);

    recordUsage("host-user", "host-topic", { inputTokens: 2, outputTokens: 1 });
    expect(getStats("host-user").total.queries).toBe(1);
    expect(readdirSync(logDir)).toEqual(["token-queries-host-user.jsonl"]);

    expect(
      createPendingAsk({
        userId: "host-user",
        from: "caller",
        to: "target",
        requestId: "host-request",
      }).ok,
    ).toBe(true);
    expect(readdirSync(join(sessionAsksDir, "host-user"))).toEqual([
      expect.stringMatching(/^v3-[a-f0-9]{64}\.pending$/),
    ]);
  });

  test("initializes every schema per injected database and never closes borrowed connections", () => {
    const first = new Database(":memory:");
    const second = new Database(":memory:");
    databases.push(first, second);

    const disposeFirst = configureStorageHost({ database: first });
    expect(getAllUserIds()).toEqual([]);
    expect(
      first
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='api_messages'",
        )
        .get()?.name,
    ).toBe("api_messages");
    flushSessionCache();
    expect(first.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    disposeFirst();

    const disposeSecond = configureStorageHost({ database: second });
    expect(db.query("PRAGMA table_info(api_topics)").all().length).toBeGreaterThan(0);
    expect(second.query("PRAGMA foreign_key_check").all()).toEqual([]);
    disposeSecond();
  });
});
