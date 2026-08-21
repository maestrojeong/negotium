import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  BINARIES_DIR,
  BROWSER_DIR,
  BROWSER_PROFILES_DIR,
  DATA_DIR,
  RUN_DIR,
  SECRETS_DIR,
  STATE_DIR,
  UPLOADS_DIR,
  VAULT_DIR,
  WORKSPACE_DIR,
} from "#platform/config";

describe("0.2 state layout", () => {
  test("test processes never resolve state into the live Negotium directory", () => {
    const liveStateDir = resolve(homedir(), ".negotium");
    const stateRelativeToLive = relative(liveStateDir, STATE_DIR);

    expect(process.env.NODE_ENV).toBe("test");
    expect(process.env.NEGOTIUM_STATE_DIR).toBeDefined();
    expect(stateRelativeToLive).not.toBe("");
    expect(stateRelativeToLive.startsWith("..")).toBe(true);
    expect(dirname(WORKSPACE_DIR)).toBe(STATE_DIR);
    expect(relative(liveStateDir, WORKSPACE_DIR).startsWith("..")).toBe(true);
    expect(relative(liveStateDir, BROWSER_DIR).startsWith("..")).toBe(true);
    expect(relative(liveStateDir, RUN_DIR).startsWith("..")).toBe(true);
  });

  test("resolves the browser, binaries, secrets, uploads, and vault roots", () => {
    expect(BROWSER_DIR).toBe(join(STATE_DIR, "browser"));
    expect(BROWSER_PROFILES_DIR).toBe(join(STATE_DIR, "browser", "profiles"));
    expect(BINARIES_DIR).toBe(join(STATE_DIR, "binaries"));
    expect(SECRETS_DIR).toBe(join(STATE_DIR, "secrets"));
    expect(UPLOADS_DIR).toBe(join(DATA_DIR, "uploads"));
    expect(VAULT_DIR).toBe(join(DATA_DIR, "vault"));
    expect(WORKSPACE_DIR).toBe(join(STATE_DIR, "workspace"));
  });

  test("retains NEGOTIUM_RUN_DIR as an explicit compatibility override", () => {
    expect(process.env.NEGOTIUM_RUN_DIR).toBeDefined();
    expect(RUN_DIR).toBe(resolve(process.env.NEGOTIUM_RUN_DIR!));
  });

  test("defaults runtime state to runtime when the legacy override is absent", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "negotium-layout-"));
    const source = resolve(import.meta.dir, "../../src/platform/config.ts");
    mkdirSync(join(stateDir, "data"), { recursive: true });
    try {
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `const c = await import(${JSON.stringify(source)}); console.log(c.RUN_DIR)`,
        ],
        env: {
          ...process.env,
          NEGOTIUM_STATE_DIR: stateDir,
          NEGOTIUM_DATA_DIR: "",
          NEGOTIUM_LOG_DIR: "",
          NEGOTIUM_RUN_DIR: "",
          NEGOTIUM_WORKSPACE_DIR: "",
          SESSIONS_DB_PATH: join(stateDir, "data", "sessions.db"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
      expect(new TextDecoder().decode(child.stdout).trim()).toBe(join(stateDir, "runtime"));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("rejects a test process without an isolated state directory", () => {
    const source = resolve(import.meta.dir, "../../src/platform/config.ts");
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", `await import(${JSON.stringify(source)})`],
      env: {
        ...process.env,
        NODE_ENV: "test",
        NEGOTIUM_STATE_DIR: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toContain("NEGOTIUM_STATE_DIR must be set");
  });
});
