import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AI_NAME, getGlobalAiName, setGlobalAiName } from "#storage/app-settings";
import { configureStorageHost } from "#storage/storage-host";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "negotium-app-settings-"));
}

describe("app settings: AI name", () => {
  test("defaults to DEFAULT_AI_NAME when no settings file exists", () => {
    const root = tempRoot();
    const dispose = configureStorageHost({ dataDir: root });
    try {
      expect(getGlobalAiName()).toBe(DEFAULT_AI_NAME);
    } finally {
      dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("set persists to disk and get round-trips it", () => {
    const root = tempRoot();
    const dispose = configureStorageHost({ dataDir: root });
    try {
      expect(setGlobalAiName("Jarvis")).toBe("Jarvis");
      expect(getGlobalAiName()).toBe("Jarvis");
      expect(existsSync(join(root, "otium-settings.json"))).toBe(true);
    } finally {
      dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty name resets to the default", () => {
    const root = tempRoot();
    const dispose = configureStorageHost({ dataDir: root });
    try {
      setGlobalAiName("Custom");
      expect(setGlobalAiName("   ")).toBe(DEFAULT_AI_NAME);
      expect(getGlobalAiName()).toBe(DEFAULT_AI_NAME);
    } finally {
      dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Regression: `getGlobalAiName` used to cache the resolved name in a
   * module-level variable the first time it was called for a given data dir,
   * and never re-read the file afterward. A long-running node process (the
   * daemon) and the short-lived `negotium name <x>` CLI process are separate
   * processes that share only the file on disk — the daemon calling
   * `getGlobalAiName()` (e.g. building a turn's system prompt, or answering
   * `/health`) must see a rename written by the CLI immediately, not only
   * after a restart. This simulates that by writing the settings file
   * directly, bypassing `setGlobalAiName` entirely — the only thing a
   * separate process could do.
   */
  test("picks up a rename written by another process without a restart", () => {
    const root = tempRoot();
    const dispose = configureStorageHost({ dataDir: root });
    try {
      expect(getGlobalAiName()).toBe(DEFAULT_AI_NAME);

      const settingsPath = join(root, "otium-settings.json");
      writeFileSync(settingsPath, JSON.stringify({ aiName: "RenamedElsewhere" }));

      expect(getGlobalAiName()).toBe("RenamedElsewhere");
    } finally {
      dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a corrupt settings file falls back to the default instead of throwing", () => {
    const root = tempRoot();
    const dispose = configureStorageHost({ dataDir: root });
    try {
      writeFileSync(join(root, "otium-settings.json"), "{not json");
      expect(getGlobalAiName()).toBe(DEFAULT_AI_NAME);
    } finally {
      dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("isolates settings per configured data dir", () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    try {
      const disposeA = configureStorageHost({ dataDir: rootA });
      setGlobalAiName("NodeA");
      disposeA();

      const disposeB = configureStorageHost({ dataDir: rootB });
      try {
        expect(getGlobalAiName()).toBe(DEFAULT_AI_NAME);
        setGlobalAiName("NodeB");
        expect(readFileSync(join(rootB, "otium-settings.json"), "utf8")).toContain("NodeB");
      } finally {
        disposeB();
      }

      const disposeA2 = configureStorageHost({ dataDir: rootA });
      try {
        expect(getGlobalAiName()).toBe("NodeA");
      } finally {
        disposeA2();
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
