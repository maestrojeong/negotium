import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionFileMissing } from "#agents/index";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("Codex hosted session root", () => {
  test("checks the hosted auth directory when it differs from CODEX_HOME", async () => {
    const hostedHome = mkdtempSync(join(tmpdir(), "negotium-hosted-codex-"));
    const inheritedHome = mkdtempSync(join(tmpdir(), "negotium-inherited-codex-"));
    const previousHome = process.env.CODEX_HOME;
    const previousAuthFile = process.env.NEGOTIUM_CODEX_AUTH_FILE;
    cleanups.push(() => {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      if (previousAuthFile === undefined) delete process.env.NEGOTIUM_CODEX_AUTH_FILE;
      else process.env.NEGOTIUM_CODEX_AUTH_FILE = previousAuthFile;
      rmSync(hostedHome, { recursive: true, force: true });
      rmSync(inheritedHome, { recursive: true, force: true });
    });

    process.env.CODEX_HOME = inheritedHome;
    process.env.NEGOTIUM_CODEX_AUTH_FILE = join(hostedHome, "auth.json");
    const sessionId = "019c0000-0000-7000-8000-000000000042";
    const bucket = join(hostedHome, "sessions", "2026", "08", "03");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, `rollout-test-${sessionId}.jsonl`), "");

    expect(await resolveSessionFileMissing("codex", sessionId, process.cwd())).toBe(false);
  });
});
