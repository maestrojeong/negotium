import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
});
