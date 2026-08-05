import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASHRS_SPILL_ROOT } from "#platform/config";
import { sessionInboxPath } from "#query/session-inbox-path";
import { flushBashrsCompletions } from "#runtime/bashrs-completions";

function writeResult(bashId: string, body: Record<string, unknown>): string {
  const dir = join(BASHRS_SPILL_ROOT, bashId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout.log"), "hello from bashrs\n");
  writeFileSync(join(dir, "stderr.log"), "");
  writeFileSync(join(dir, "result.json"), JSON.stringify(body));
  return dir;
}

afterEach(() => {
  rmSync(BASHRS_SPILL_ROOT, { recursive: true, force: true });
});

describe("bashrs-completions", () => {
  test("delivers a result.json as a session-inbox tell and marks it injected", async () => {
    const dir = writeResult("bash_abc123", {
      bash_id: "bash_abc123",
      owner: "user-1\0topic-1",
      exit_code: 0,
      finished_at_ms: Date.now(),
      matched_line: null,
      unknown: false,
    });

    await flushBashrsCompletions();

    const inboxPath = sessionInboxPath("user-1", "topic-1");
    const lines = readFileSync(inboxPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe("tell");
    expect(entry.from).toBe("__bg_bash__");
    expect(entry.requestId).toBe("bash_abc123");
    expect(entry.message).toContain("hello from bashrs");
    expect(entry.message).toContain("exit code: 0");

    // result.json is consumed — renamed, not left for a re-delivery.
    expect(existsSync(join(dir, "result.json"))).toBe(false);
    expect(existsSync(join(dir, "result.json.injected"))).toBe(true);
  });

  test("is idempotent: a second sweep does not re-deliver", async () => {
    writeResult("bash_def456", {
      bash_id: "bash_def456",
      owner: "user-2\0topic-2",
      exit_code: 1,
      finished_at_ms: Date.now(),
      matched_line: null,
      unknown: false,
    });

    await flushBashrsCompletions();
    await flushBashrsCompletions();
    await flushBashrsCompletions();

    const inboxPath = sessionInboxPath("user-2", "topic-2");
    const lines = readFileSync(inboxPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("skips owners that aren't negotium's userId\\0topicId convention", async () => {
    writeResult("bash_ghi789", {
      bash_id: "bash_ghi789",
      owner: "bare-topic-no-nul",
      exit_code: 0,
      finished_at_ms: Date.now(),
      matched_line: null,
      unknown: false,
    });

    await flushBashrsCompletions();

    // Nothing to assert a positive path on — just must not throw, and must
    // leave result.json alone so a *different* consumer (e.g. clawgram's own
    // watcher, if it ever shared this directory) still has a chance at it.
    expect(existsSync(join(BASHRS_SPILL_ROOT, "bash_ghi789", "result.json"))).toBe(true);
  });

  test("reports a watch match distinctly from a plain exit", async () => {
    writeResult("bash_watch1", {
      bash_id: "bash_watch1",
      owner: "user-3\0topic-3",
      exit_code: null,
      finished_at_ms: Date.now(),
      matched_line: "deploy ready",
      unknown: false,
    });

    await flushBashrsCompletions();

    const inboxPath = sessionInboxPath("user-3", "topic-3");
    const entry = JSON.parse(readFileSync(inboxPath, "utf8").trim());
    expect(entry.message).toContain("matched]");
    expect(entry.message).toContain("deploy ready");
  });

  test("marks an unknown-exit-code (post-restart) result distinctly", async () => {
    writeResult("bash_orphan1", {
      bash_id: "bash_orphan1",
      owner: "user-4\0topic-4",
      exit_code: null,
      finished_at_ms: Date.now(),
      matched_line: null,
      unknown: true,
    });

    await flushBashrsCompletions();

    const inboxPath = sessionInboxPath("user-4", "topic-4");
    const entry = JSON.parse(readFileSync(inboxPath, "utf8").trim());
    expect(entry.message).toContain("exit code: unknown");
  });
});
