import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRON_JOBS_DIR,
  CronScriptError,
  runCronPromptScript,
  validateCronScriptName,
} from "../src/scripts";

const created: string[] = [];
const originalPython = process.env.NEGOTIUM_CRON_PYTHON;

function writeNodeFixture(name: string, source: string): void {
  mkdirSync(CRON_JOBS_DIR, { recursive: true });
  const path = join(CRON_JOBS_DIR, name);
  writeFileSync(path, source);
  created.push(path);
  process.env.NEGOTIUM_CRON_PYTHON = process.execPath;
}

afterEach(() => {
  for (const path of created.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // Already removed.
    }
  }
  if (originalPython === undefined) delete process.env.NEGOTIUM_CRON_PYTHON;
  else process.env.NEGOTIUM_CRON_PYTHON = originalPython;
});

describe("cron prompt scripts", () => {
  test("accepts only plain Python filenames", () => {
    expect(validateCronScriptName("daily-report.py")).toEqual({ ok: true });
    expect(validateCronScriptName("../escape.py").ok).toBe(false);
    expect(validateCronScriptName("nested/job.py").ok).toBe(false);
    expect(validateCronScriptName("job.sh").ok).toBe(false);
  });

  test("uses stdout as the agent prompt", async () => {
    writeNodeFixture("test-prompt.py", 'console.log("inspect yesterday then report")');

    await expect(
      runCronPromptScript({
        script: "test-prompt.py",
        cwd: CRON_JOBS_DIR,
        jobId: "job-1",
        topicId: "topic-1",
      }),
    ).resolves.toBe("inspect yesterday then report");
  });

  test("terminates scripts whose output exceeds the configured bound", async () => {
    writeNodeFixture("test-output-limit.py", 'console.log("x".repeat(4096))');

    const error = await runCronPromptScript({
      script: "test-output-limit.py",
      cwd: CRON_JOBS_DIR,
      jobId: "job-2",
      topicId: "topic-1",
      outputLimitBytes: 1024,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(CronScriptError);
    expect((error as CronScriptError).kind).toBe("output-limit");
  });

  test("terminates the script process group when the scheduler stops", async () => {
    writeNodeFixture("test-abort.py", "setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const running = runCronPromptScript({
      script: "test-abort.py",
      cwd: CRON_JOBS_DIR,
      jobId: "job-3",
      topicId: "topic-1",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    const error = await running.catch((caught) => caught);

    expect(error).toBeInstanceOf(CronScriptError);
    expect((error as CronScriptError).message).toBe("script run aborted");
  });
});
