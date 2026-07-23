import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { extractChatPairs } from "#agents/rollout/shared";
import { WORKSPACE_DIR } from "#platform/config";
import type { ConversationEntry } from "#storage/conversations";

// Synthetic rollout writers expect their cwd under WORKSPACE_DIR (the A1
// trust boundary). Use a tmp dir inside it so the writers' path-encoding
// logic runs against a real, isolated location.
mkdirSync(WORKSPACE_DIR, { recursive: true });
const TMP_CWD = mkdtempSync(join(WORKSPACE_DIR, "test-rollout-"));
const writtenPaths: string[] = [];
const CODEX_SESSIONS_DIR = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

afterAll(() => {
  // Best-effort cleanup of synthesized rollouts written under ~/.claude and
  // ~/.codex during the test run, plus the tmp cwd.
  for (const p of writtenPaths) {
    try {
      rmSync(p, { force: true });
    } catch {}
  }
  try {
    rmSync(TMP_CWD, { recursive: true, force: true });
  } catch {}
});

function entry(event: ConversationEntry["event"]): ConversationEntry {
  return { ts: "2026-01-01T00:00:00Z", agent: "claude", event };
}

describe("extractChatPairs", () => {
  test("pairs user_message with the following result", () => {
    const pairs = extractChatPairs([
      entry({ type: "user_message", content: "hi" }),
      entry({ type: "text", content: "hel" }),
      entry({ type: "text", content: "lo" }),
      entry({ type: "result", content: "hello", stopReason: "end_turn" }),
    ]);
    expect(pairs).toEqual([{ userText: "hi", assistantText: "hello" }]);
  });

  test("result content overrides accumulated text chunks", () => {
    // The provider may stream partial `text` events that don't equal the
    // final `result.content`. The encoder must trust `result` as canonical.
    const pairs = extractChatPairs([
      entry({ type: "user_message", content: "q" }),
      entry({ type: "text", content: "partial" }),
      entry({ type: "result", content: "FINAL", stopReason: "end_turn" }),
    ]);
    expect(pairs[0].assistantText).toBe("FINAL");
  });

  test("text_delta events are dropped", () => {
    const pairs = extractChatPairs([
      entry({ type: "user_message", content: "q" }),
      entry({ type: "text_delta", content: "he" }),
      entry({ type: "text_delta", content: "llo" }),
      entry({ type: "result", content: "hello", stopReason: "end_turn" }),
    ]);
    expect(pairs[0].assistantText).toBe("hello");
  });

  test("tool_use/tool_result fold into bracketed annotations", () => {
    const pairs = extractChatPairs([
      entry({ type: "user_message", content: "list" }),
      entry({ type: "tool_use", name: "Bash", input: { command: "ls" } }),
      entry({ type: "tool_result", toolUseId: "x", content: "a\nb\nc" }),
      entry({ type: "result", content: "done", stopReason: "end_turn" }),
    ]);
    expect(pairs[0].assistantText).toContain("done");
    expect(pairs[0].assistantText).toContain("<!-- Tool: Bash");
    expect(pairs[0].assistantText).toContain("<!-- Tool result:");
  });

  test("multiple turns produce one pair per user_message", () => {
    const pairs = extractChatPairs([
      entry({ type: "user_message", content: "q1" }),
      entry({ type: "result", content: "a1", stopReason: "end_turn" }),
      entry({ type: "user_message", content: "q2" }),
      entry({ type: "result", content: "a2", stopReason: "end_turn" }),
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ userText: "q1", assistantText: "a1" });
    expect(pairs[1]).toEqual({ userText: "q2", assistantText: "a2" });
  });

  test("session events mid-turn don't split a pair", () => {
    // Provider emits a `session` event after the user prompt but before the
    // assistant text on the very first turn. The pair must remain intact.
    const pairs = extractChatPairs([
      entry({ type: "user_message", content: "q" }),
      entry({ type: "session", sessionId: "abc-123" }),
      entry({ type: "result", content: "a", stopReason: "end_turn" }),
    ]);
    expect(pairs).toEqual([{ userText: "q", assistantText: "a" }]);
  });

  test("turns with no assistant text are dropped", () => {
    // A user prompt that produced no output (aborted, error, etc.) should
    // not synthesize a pair — replaying it would inject an empty assistant
    // turn that the SDKs may reject or render weirdly.
    const pairs = extractChatPairs([
      entry({ type: "user_message", content: "abandoned" }),
      entry({ type: "user_message", content: "q" }),
      entry({ type: "result", content: "a", stopReason: "end_turn" }),
    ]);
    expect(pairs).toEqual([{ userText: "q", assistantText: "a" }]);
  });
});

describe("writeClaudeRollout", () => {
  test("produces a valid JSONL containing the supplied dialogue", async () => {
    const { writeClaudeRollout } = await import("#agents/rollout/claude");
    const result = writeClaudeRollout({
      cwd: TMP_CWD,
      pairs: [{ userText: "ping", assistantText: "pong" }],
    });
    writtenPaths.push(result.rolloutPath);
    expect(existsSync(result.rolloutPath)).toBe(true);
    const lines = readFileSync(result.rolloutPath, "utf8").trim().split("\n");
    // Every line must parse as JSON — the on-disk format is JSONL and
    // partial truncation here would silently break SDK resume.
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const all = lines.map((l) => JSON.parse(l));
    expect(all.some((l) => JSON.stringify(l).includes("ping"))).toBe(true);
    expect(all.some((l) => JSON.stringify(l).includes("pong"))).toBe(true);
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("stamps synthesized assistant history with the selected model", async () => {
    const { writeClaudeRollout } = await import("#agents/rollout/claude");
    const result = writeClaudeRollout({
      cwd: TMP_CWD,
      model: "claude-fable-5",
      pairs: [{ userText: "model?", assistantText: "fable" }],
    });
    writtenPaths.push(result.rolloutPath);
    const entries = readFileSync(result.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const assistant = entries.find((item) => item.type === "assistant");
    expect(assistant?.message?.model).toBe("claude-fable-5");
  });

  test("rejects cwds outside the workspace roots", async () => {
    const { writeClaudeRollout } = await import("#agents/rollout/claude");
    expect(() => writeClaudeRollout({ cwd: "/etc/passwd-traversal", pairs: [] })).toThrow(
      /outside trusted workspace roots/,
    );
  });

  // Regression for the path-encoding bug: a previous implementation only
  // converted `/` → `-` and left `_` intact, so synthetic rollouts for paths
  // with underscores landed under a different encoded directory than the Claude
  // SDK expects (it normalizes ANY non-__KEEP_MAESTRONUMERIC__ to `-`). Result was
  // "No conversation found with session ID" on every set_agent resume.
  test("path encoding matches SDK normalization (`_` → `-`)", async () => {
    const { writeClaudeRollout } = await import("#agents/rollout/claude");
    const userDirWithUnderscore = mkdtempSync(join(WORKSPACE_DIR, "test_rollout_"));
    try {
      const result = writeClaudeRollout({
        cwd: userDirWithUnderscore,
        pairs: [{ userText: "p", assistantText: "a" }],
      });
      writtenPaths.push(result.rolloutPath);
      // The underscore-bearing cwd MUST encode with `-`s in the rollout path —
      // otherwise the SDK silently misses our synthetic file at resume time.
      const encoded = result.rolloutPath.split("/.claude/projects/")[1]?.split("/")[0];
      expect(encoded).toBeDefined();
      expect(encoded).not.toContain("_");
      // Trailing component is the cwd basename with `_` flattened to `-`.
      const expectedTail = userDirWithUnderscore.split("/").pop()!.replaceAll("_", "-");
      expect(encoded!.endsWith(expectedTail)).toBe(true);
    } finally {
      rmSync(userDirWithUnderscore, { recursive: true, force: true });
    }
  });

  // Round-trip: when set_agent reuses a prior sessionId (claude → codex →
  // claude), the synthetic rollout must land at the SAME path the SDK
  // already manages — no orphan files, no silent fresh-session fallback.
  test("reuses provided sessionId so the rollout path is stable across switches", async () => {
    const { writeClaudeRollout } = await import("#agents/rollout/claude");
    const first = writeClaudeRollout({
      cwd: TMP_CWD,
      pairs: [{ userText: "round 1", assistantText: "ack 1" }],
    });
    writtenPaths.push(first.rolloutPath);
    const second = writeClaudeRollout({
      cwd: TMP_CWD,
      sessionId: first.sessionId, // simulate set_agent's reuseSessionId path
      pairs: [
        { userText: "round 1", assistantText: "ack 1" },
        { userText: "round 2", assistantText: "ack 2" },
      ],
    });
    writtenPaths.push(second.rolloutPath);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.rolloutPath).toBe(first.rolloutPath);
    // The reused write must overwrite atomically with the FULL history so
    // SDK resume sees both rounds in one continuous session.
    const lines = readFileSync(second.rolloutPath, "utf8").trim().split("\n");
    const flat = lines.map((l) => JSON.parse(l));
    expect(flat.some((l) => JSON.stringify(l).includes("round 2"))).toBe(true);
    expect(flat.some((l) => JSON.stringify(l).includes("ack 2"))).toBe(true);
  });
});

describe("repairPoisonedRollout", () => {
  async function writeRawClaudeRollout(cwd: string, entries: unknown[]) {
    const { encodeClaudeCwd } = await import("#agents/rollout/claude");
    const sessionId = randomUUID();
    const path = join(homedir(), ".claude", "projects", encodeClaudeCwd(cwd), `${sessionId}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
    writtenPaths.push(path);
    return { sessionId, path };
  }

  test("drops the poisoned max_tokens thinking turn, not the latest retry user", async () => {
    const { repairPoisonedRollout } = await import("#agents/rollout/claude");
    const { sessionId, path } = await writeRawClaudeRollout(TMP_CWD, [
      { type: "queue-operation", operation: "enqueue" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "keep q" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "keep a" }],
          stop_reason: "end_turn",
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "bad q" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "truncated" }],
          stop_reason: "max_tokens",
        },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "retry after 400" }] },
      },
    ]);

    expect(repairPoisonedRollout(sessionId, TMP_CWD)).toBe(true);
    const repaired = readFileSync(path, "utf8");
    expect(repaired).toContain("keep q");
    expect(repaired).toContain("keep a");
    expect(repaired).not.toContain("bad q");
    expect(repaired).not.toContain("truncated");
    expect(repaired).not.toContain("retry after 400");
  });

  test("leaves plain max_tokens text turns alone", async () => {
    const { repairPoisonedRollout } = await import("#agents/rollout/claude");
    const { sessionId, path } = await writeRawClaudeRollout(TMP_CWD, [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "long q" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "long ordinary answer" }],
          stop_reason: "max_tokens",
        },
      },
    ]);
    const before = readFileSync(path, "utf8");

    expect(repairPoisonedRollout(sessionId, TMP_CWD)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("writeCodexRollout", () => {
  test("records native multi-agent as disabled for future resumes", async () => {
    const { migrateCodexRolloutNativeMultiAgentMetadata, writeCodexRollout } = await import(
      "#agents/rollout/codex"
    );
    const result = writeCodexRollout({ cwd: TMP_CWD, pairs: [] });
    writtenPaths.push(result.rolloutPath);
    let lines = readFileSync(result.rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines[0]?.payload?.multi_agent_version).toBe("disabled");
    expect(lines.find((line) => line.type === "turn_context")?.payload?.multi_agent_version).toBe(
      "disabled",
    );
    expect(migrateCodexRolloutNativeMultiAgentMetadata(result.threadId)).toBe(false);

    lines = lines.map((line) => {
      if (line.type === "session_meta" || line.type === "turn_context") {
        line.payload.multi_agent_version = "v1";
      }
      return line;
    });
    writeFileSync(result.rolloutPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    expect(migrateCodexRolloutNativeMultiAgentMetadata(result.threadId)).toBe(true);
    const migrated = readFileSync(result.rolloutPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === "session_meta" || line.type === "turn_context");
    expect(migrated.every((line) => line.payload.multi_agent_version === "disabled")).toBe(true);
  });

  test("migrates a rollout stored in a local-date bucket that skews from the UUID's UTC day", async () => {
    const { migrateCodexRolloutNativeMultiAgentMetadata, readLatestCodexContextUsage } =
      await import("#agents/rollout/codex");
    // UUIDv7 timestamps are UTC, but Codex names session dirs by the local date.
    // Pick an early-UTC-day timestamp and file it under the *previous* day's
    // bucket, exactly as a negative-offset timezone would in the evening.
    const utcMs = Date.UTC(2026, 6, 17, 2, 0, 0);
    const hex = utcMs.toString(16).padStart(12, "0");
    const threadId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8abc-abcdef012345`;

    const codexHome = mkdtempSync(join(WORKSPACE_DIR, "test-codex-home-"));
    const previousEnv = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const bucketDir = join(codexHome, "sessions", "2026", "07", "16");
      mkdirSync(bucketDir, { recursive: true });
      const rolloutPath = join(bucketDir, `rollout-2026-07-16T19-00-00-${threadId}.jsonl`);
      const lines = [
        { type: "session_meta", payload: { id: threadId, multi_agent_version: "v1" } },
        { type: "turn_context", payload: { turn_id: "t1", multi_agent_version: "v2" } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 321 },
              model_context_window: 128_000,
            },
          },
        },
      ];
      writeFileSync(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

      expect(readLatestCodexContextUsage(threadId)).toEqual({
        contextTokens: 321,
        contextWindow: 128_000,
      });
      expect(migrateCodexRolloutNativeMultiAgentMetadata(threadId)).toBe(true);
      const migrated = readFileSync(rolloutPath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((line) => line.type === "session_meta" || line.type === "turn_context");
      expect(migrated.every((line) => line.payload.multi_agent_version === "disabled")).toBe(true);
    } finally {
      if (previousEnv === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousEnv;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("finds context usage outside a valid UUIDv7 thread's expected date buckets", async () => {
    const { readLatestCodexContextUsage } = await import("#agents/rollout/codex");
    const utcMs = Date.UTC(2026, 6, 17, 2, 0, 0);
    const hex = utcMs.toString(16).padStart(12, "0");
    const threadId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8abc-abcdef012345`;

    const codexHome = mkdtempSync(join(WORKSPACE_DIR, "test-codex-home-"));
    const previousEnv = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const unexpectedDir = join(codexHome, "sessions", "2025", "01", "02");
      mkdirSync(unexpectedDir, { recursive: true });
      const rolloutPath = join(unexpectedDir, `rollout-2025-01-02T00-00-00-${threadId}.jsonl`);
      writeFileSync(
        rolloutPath,
        `${JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 654 },
              model_context_window: 128_000,
            },
          },
        })}\n`,
      );

      expect(readLatestCodexContextUsage(threadId)).toEqual({
        contextTokens: 654,
        contextWindow: 128_000,
      });
    } finally {
      if (previousEnv === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousEnv;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("extracts the latest per-request context usage from token-count events", async () => {
    const { extractLatestCodexContextUsage } = await import("#agents/rollout/codex");
    const jsonl = [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 50_000 },
            model_context_window: 258_400,
          },
        },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 104_464 },
            model_context_window: 258_400,
          },
        },
      }),
      '{"type":"event_msg","payload":',
    ].join("\n");

    expect(extractLatestCodexContextUsage(jsonl)).toEqual({
      contextTokens: 104_464,
      contextWindow: 258_400,
    });
  });

  test("extracts exact native Codex patch lines and skips consumed calls", async () => {
    const { extractCodexPatchCallIds, extractLatestCodexPatchPreview } = await import(
      "#agents/rollout/codex"
    );
    const path = join(TMP_CWD, "native-preview.ts");
    const jsonl = [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "old-call",
          changes: {
            [path]: {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-const value = 'older';\n+const value = 'old';\n",
            },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "new-call",
          changes: {
            [path]: {
              type: "update",
              unified_diff:
                "@@ -2,3 +2,3 @@\n const kept = true;\n-const value = 'old';\n+const value = 'new';\n const tail = true;\n",
            },
          },
        },
      }),
    ].join("\n");

    expect(extractCodexPatchCallIds(jsonl)).toEqual(["old-call", "new-call"]);
    expect(extractLatestCodexPatchPreview(jsonl, [path], new Set(["old-call"]))).toEqual({
      callId: "new-call",
      changes: [
        {
          path,
          before: "const value = 'old';",
          after: "const value = 'new';",
          diffPreview:
            "2  const kept = true;\n3 -const value = 'old';\n3 +const value = 'new';\n4  const tail = true;",
        },
      ],
    });
    expect(
      extractLatestCodexPatchPreview(jsonl, [path], new Set(["old-call", "new-call"])),
    ).toBeUndefined();
    expect(extractLatestCodexPatchPreview(jsonl, [path], new Set(), "new-call")?.callId).toBe(
      "new-call",
    );
    expect(
      extractLatestCodexPatchPreview(jsonl, [path], new Set(), "missing-call"),
    ).toBeUndefined();

    const markerContent = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "marker-content",
        changes: {
          [path]: {
            type: "update",
            unified_diff: "@@ -1 +1 @@\n--- old heading\n+++ new heading\n",
          },
        },
      },
    });
    expect(extractLatestCodexPatchPreview(markerContent, [path])).toEqual({
      callId: "marker-content",
      changes: [
        {
          path,
          before: "-- old heading",
          after: "++ new heading",
          diffPreview: "1 --- old heading\n1 +++ new heading",
        },
      ],
    });
  });

  test("produces a valid JSONL containing the supplied dialogue", async () => {
    const { writeCodexRollout } = await import("#agents/rollout/codex");
    const result = writeCodexRollout({
      cwd: TMP_CWD,
      pairs: [{ userText: "ping", assistantText: "pong" }],
    });
    writtenPaths.push(result.rolloutPath);
    expect(existsSync(result.rolloutPath)).toBe(true);
    const lines = readFileSync(result.rolloutPath, "utf8").trim().split("\n");
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const all = lines.map((l) => JSON.parse(l));
    expect(all.some((l) => JSON.stringify(l).includes("ping"))).toBe(true);
    expect(all.some((l) => JSON.stringify(l).includes("pong"))).toBe(true);
    expect(result.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("stamps the selected model and effort into synthetic turn context", async () => {
    const { writeCodexRollout } = await import("#agents/rollout/codex");
    const result = writeCodexRollout({
      cwd: TMP_CWD,
      model: "gpt-5.6-sol",
      effort: "high",
      pairs: [{ userText: "model?", assistantText: "sol" }],
    });
    writtenPaths.push(result.rolloutPath);
    const entries = readFileSync(result.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const turn = entries.find((item) => item.type === "turn_context");
    expect(turn?.payload?.model).toBe("gpt-5.6-sol");
    expect(turn?.payload?.collaboration_mode?.settings).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    });
    expect(turn?.payload?.current_date).toBe(
      [
        new Date().getFullYear(),
        String(new Date().getMonth() + 1).padStart(2, "0"),
        String(new Date().getDate()).padStart(2, "0"),
      ].join("-"),
    );
    expect(turn?.payload?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(turn?.payload?.sandbox_policy).toEqual({ type: "danger-full-access" });
    expect(turn?.payload?.approval_policy).toBe("never");
    expect(turn?.payload?.permission_profile).toBeUndefined();

    const developer = entries.find(
      (item) => item.type === "response_item" && item.payload?.role === "developer",
    );
    const developerText = JSON.stringify(developer?.payload?.content ?? []);
    expect(developerText).toContain("danger-full-access");
    expect(developerText).not.toContain("read-only");
    expect(developerText).not.toContain("/Users/maestrobot");

    const environment = entries.find(
      (item) =>
        item.type === "response_item" &&
        item.payload?.role === "user" &&
        JSON.stringify(item.payload?.content).includes("<environment_context>"),
    );
    const environmentText = JSON.stringify(environment?.payload?.content ?? []);
    expect(environmentText).toContain(TMP_CWD);
    expect(environmentText).toContain(turn?.payload?.current_date);
    expect(environmentText).toContain(turn?.payload?.timezone);
  });

  // Codex side of the same round-trip guarantee: codex → claude → codex must
  // end up on the original codex thread, not a fresh uuidv7 every time.
  test("reuses provided threadId across switches", async () => {
    const { writeCodexRollout } = await import("#agents/rollout/codex");
    const first = writeCodexRollout({
      cwd: TMP_CWD,
      pairs: [{ userText: "r1", assistantText: "a1" }],
    });
    writtenPaths.push(first.rolloutPath);
    const second = writeCodexRollout({
      cwd: TMP_CWD,
      threadId: first.threadId,
      pairs: [
        { userText: "r1", assistantText: "a1" },
        { userText: "r2", assistantText: "a2" },
      ],
    });
    writtenPaths.push(second.rolloutPath);
    expect(second.threadId).toBe(first.threadId);
  });

  // Round-trip prior-cleanup (I1 fix): when a reused threadId has a rollout
  // sitting at the ORIGINAL write date (set_agent claude→codex→...claude→codex
  // pattern where the first codex turn was, say, last week), the second write
  // must unlink it so `codex resume <tid>` sees exactly one match. Before the
  // fix the SDK could pick either file depending on glob order with no spec.
  //
  // Same-second / same-day collisions are handled by overwrite (path matches),
  // so we simulate the real failure case: a threadId whose embedded timestamp
  // sits far in the past (>30 day MAX_DAY_SPAN). The optimized fast-path
  // gives up on huge spans and falls back to the whole-tree scan, which must
  // still find and unlink the old rollout.
  test("reused threadId sweeps prior rollout from a different-date directory", async () => {
    const { renameSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { writeCodexRollout } = await import("#agents/rollout/codex");

    // UUIDv7 whose embedded ms decodes to 2025-01-01T00:00:00Z. First 12
    // hex chars = 0x01940000fe00 = 1735689600000 ms = Jan 1 2025 UTC.
    // Span (2025-01-01 → today) is far past MAX_DAY_SPAN (30) so the sweep
    // falls back to the whole-tree scan and must still catch the relocated
    // file. This pins both the cleanup contract and the fast-path's graceful
    // degradation behavior.
    const STALE_THREAD_ID = "01940000-fe00-7398-ac78-740837adc9c4";

    const first = writeCodexRollout({
      cwd: TMP_CWD,
      threadId: STALE_THREAD_ID,
      pairs: [{ userText: "old", assistantText: "old-reply" }],
    });

    // Relocate to the threadId's encoded date directory — that's where the
    // SDK would have originally put it.
    const sessionsDir = CODEX_SESSIONS_DIR;
    const oldDir = join(sessionsDir, "2025", "01", "01");
    mkdirSync(oldDir, { recursive: true });
    const oldPath = join(oldDir, `rollout-2025-01-01T00-00-00-${first.threadId}.jsonl`);
    renameSync(first.rolloutPath, oldPath);
    writtenPaths.push(oldPath); // belt-and-suspenders cleanup
    expect(existsSync(oldPath)).toBe(true);

    const second = writeCodexRollout({
      cwd: TMP_CWD,
      threadId: first.threadId,
      pairs: [
        { userText: "old", assistantText: "old-reply" },
        { userText: "new", assistantText: "new-reply" },
      ],
    });
    writtenPaths.push(second.rolloutPath);

    expect(second.threadId).toBe(first.threadId);
    // The relocated (different-date) old file is gone — sweep caught it.
    expect(existsSync(oldPath)).toBe(false);
    // The new write survives at today's date directory.
    expect(existsSync(second.rolloutPath)).toBe(true);
    const lines = readFileSync(second.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.some((l) => JSON.stringify(l).includes("new-reply"))).toBe(true);
  });

  // Fresh-mint threadIds (no `opts.threadId` supplied) must NOT trigger the
  // sweep — there's nothing to clean and a stray glob could match unrelated
  // files in degenerate setups.
  test("fresh-mint threadId does not sweep unrelated rollouts", async () => {
    const { writeCodexRollout } = await import("#agents/rollout/codex");
    const a = writeCodexRollout({
      cwd: TMP_CWD,
      pairs: [{ userText: "a", assistantText: "A" }],
    });
    writtenPaths.push(a.rolloutPath);
    // Different threadId — a's file must survive a separate write.
    const b = writeCodexRollout({
      cwd: TMP_CWD,
      pairs: [{ userText: "b", assistantText: "B" }],
    });
    writtenPaths.push(b.rolloutPath);
    expect(a.threadId).not.toBe(b.threadId);
    expect(existsSync(a.rolloutPath)).toBe(true);
    expect(existsSync(b.rolloutPath)).toBe(true);
  });

  test("decodeUuidV7Timestamp recovers the embedded ms timestamp", async () => {
    const { decodeUuidV7Timestamp } = await import("#agents/rollout/codex");
    // Hand-crafted UUIDv7. First 12 hex digits encode unix ms in big-endian.
    const tid = "019e2e64-12a6-7398-ac78-740837adc9c4";
    const ms = decodeUuidV7Timestamp(tid);
    expect(ms).toBe(0x019e2e6412a6);
    // Sanity: decodes to a 2026-era date, NOT 1970 (which would mean we
    // parsed the wrong slice of the id).
    expect(new Date(ms as number).getUTCFullYear()).toBeGreaterThanOrEqual(2025);
  });

  test("decodeUuidV7Timestamp rejects malformed and out-of-window ids", async () => {
    const { decodeUuidV7Timestamp } = await import("#agents/rollout/codex");
    // Non-UUID shape.
    expect(decodeUuidV7Timestamp("not-a-uuid")).toBeNull();
    // Wrong version (4, not 7) — sweep falls back to whole-tree scan.
    expect(decodeUuidV7Timestamp("019e2e64-12a6-4398-ac78-740837adc9c4")).toBeNull();
    // Shape OK + version 7, but encoded ms = 0 → 1970 → outside plausibility
    // window (MIN = 2020). Defensive: don't point the sweep at a non-existent
    // bucket on a clearly malformed id; fall back to whole-tree scan.
    expect(decodeUuidV7Timestamp("00000000-0000-7000-8000-000000000000")).toBeNull();
  });

  // Performance/scoping regression: with a UUIDv7 threadId the sweep should
  // hit ONLY the threadId's birth-date bucket + today's bucket, not the
  // sibling date directories from a year ago. We seed an unrelated rollout
  // in a far-away date dir and assert it survives the new write.
  test("date-bucketed sweep ignores unrelated date directories", async () => {
    const { mkdirSync, writeFileSync: writeFs } = await import("node:fs");
    const { join: pj } = await import("node:path");
    const { writeCodexRollout } = await import("#agents/rollout/codex");

    // Mint a fresh threadId — uuidv7()'s embedded ms pins the candidate
    // buckets to (today, today) since the id was just generated.
    const minted = writeCodexRollout({
      cwd: TMP_CWD,
      pairs: [{ userText: "a", assistantText: "A" }],
    });
    writtenPaths.push(minted.rolloutPath);

    // Drop a file with a DIFFERENT threadId in a far-away bucket. The sweep
    // keyed on `minted.threadId` must NOT touch it: different id (filename
    // doesn't match), AND the 2024-06 bucket isn't in the candidate set
    // anyway.
    const sessionsDir = CODEX_SESSIONS_DIR;
    const farDir = pj(sessionsDir, "2024", "06", "15");
    mkdirSync(farDir, { recursive: true });
    const unrelated = pj(
      farDir,
      "rollout-2024-06-15T00-00-00-019099a1-0000-7000-8000-000000000000.jsonl",
    );
    writeFs(unrelated, "{}\n");
    writtenPaths.push(unrelated);

    const second = writeCodexRollout({
      cwd: TMP_CWD,
      threadId: minted.threadId,
      pairs: [
        { userText: "a", assistantText: "A" },
        { userText: "b", assistantText: "B" },
      ],
    });
    writtenPaths.push(second.rolloutPath);

    expect(existsSync(unrelated)).toBe(true); // optimized sweep skipped this dir
    expect(existsSync(second.rolloutPath)).toBe(true);
  });
});

describe("purgeTopicLogs", () => {
  // The orchestrator tests focus on the contract: read manifest → delete
  // SDK rollouts in workspace path → unlink unified log. Glob coverage for
  // codex's date-prefixed paths is exercised via writeCodexRollout's known
  // output location, ensuring real-world layout matches.
  test("removes unified log + every per-agent SDK rollout the topic produced", async () => {
    const { writeClaudeRollout } = await import("#agents/rollout/claude");
    const { writeCodexRollout } = await import("#agents/rollout/codex");
    const { purgeTopicLogs } = await import("#agents/topic-cleanup");
    const { appendConversationEvent, getConversationPath } = await import("#storage/conversations");

    // Use a per-test cwd so this test's rollouts don't collide with other tests.
    const cwd = mkdtempSync(join(WORKSPACE_DIR, "test-purge-"));
    const userId = "999999";
    const topicName = "purge-test";
    try {
      const claudeWrite = writeClaudeRollout({
        cwd,
        pairs: [{ userText: "p", assistantText: "a" }],
      });
      const codexWrite = writeCodexRollout({
        cwd,
        pairs: [{ userText: "p", assistantText: "a" }],
      });

      // Manifest the writes through the unified log so purgeTopicLogs can
      // discover them via session events.
      appendConversationEvent(userId, topicName, "claude", {
        type: "session",
        sessionId: claudeWrite.sessionId,
      });
      appendConversationEvent(userId, topicName, "codex", {
        type: "session",
        sessionId: codexWrite.threadId,
      });

      const unifiedPath = getConversationPath(userId, topicName);
      expect(existsSync(unifiedPath)).toBe(true);
      expect(existsSync(claudeWrite.rolloutPath)).toBe(true);
      expect(existsSync(codexWrite.rolloutPath)).toBe(true);

      await purgeTopicLogs({ userId, topicName, cwd });

      // All three artifacts gone — unified log + both SDK rollouts.
      expect(existsSync(unifiedPath)).toBe(false);
      expect(existsSync(claudeWrite.rolloutPath)).toBe(false);
      expect(existsSync(codexWrite.rolloutPath)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("removes current DB session even when it has not reached the unified log", async () => {
    const { writeClaudeRollout } = await import("#agents/rollout/claude");
    const { purgeTopicLogs } = await import("#agents/topic-cleanup");
    const { appendConversationEvent, getConversationPath } = await import("#storage/conversations");

    const cwd = mkdtempSync(join(WORKSPACE_DIR, "test-purge-extra-"));
    const userId = "999997";
    const topicName = "purge-extra-test";
    try {
      const write = writeClaudeRollout({
        cwd,
        pairs: [{ userText: "before switch", assistantText: "bridge me" }],
      });

      // Create a unified log that has history but does not mention the newly
      // written rollout id. This mirrors set_agent: it writes a synthetic
      // rollout and stores the id in DB before the target SDK emits `session`.
      appendConversationEvent(userId, topicName, "codex", {
        type: "user_message",
        content: "old history",
      });

      const unifiedPath = getConversationPath(userId, topicName);
      expect(existsSync(unifiedPath)).toBe(true);
      expect(existsSync(write.rolloutPath)).toBe(true);

      await purgeTopicLogs({
        userId,
        topicName,
        cwd,
        extraSessions: [{ agent: "claude", sessionId: write.sessionId }],
      });

      expect(existsSync(unifiedPath)).toBe(false);
      expect(existsSync(write.rolloutPath)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("is idempotent — second call on a purged topic is a no-op", async () => {
    const { purgeTopicLogs } = await import("#agents/topic-cleanup");
    // Empty unified log + nothing on disk → must not throw.
    await purgeTopicLogs({
      userId: "999998",
      topicName: "nonexistent",
      cwd: TMP_CWD,
    });
    // Calling twice in a row likewise must not throw.
    await purgeTopicLogs({
      userId: "999998",
      topicName: "nonexistent",
      cwd: TMP_CWD,
    });
  });
});

describe("findLastSessionIdForAgent", () => {
  test("returns the most recent session id for the requested agent", async () => {
    const { findLastSessionIdForAgent } = await import("#storage/conversations");
    const c1 = "11111111-1111-4111-8111-111111111111";
    const c2 = "22222222-2222-4222-8222-222222222222";
    const x1 = "33333333-3333-4333-8333-333333333333";
    const log: ConversationEntry[] = [
      { ts: "t1", agent: "claude", event: { type: "session", sessionId: c1 } },
      { ts: "t2", agent: "claude", event: { type: "user_message", content: "hi" } },
      { ts: "t3", agent: "codex", event: { type: "session", sessionId: x1 } },
      { ts: "t4", agent: "claude", event: { type: "session", sessionId: c2 } },
    ];
    expect(findLastSessionIdForAgent(log, "claude")).toBe(c2);
    expect(findLastSessionIdForAgent(log, "codex")).toBe(x1);
  });

  test("returns null when the agent has never run on the topic", async () => {
    const { findLastSessionIdForAgent } = await import("#storage/conversations");
    const log: ConversationEntry[] = [
      {
        ts: "t1",
        agent: "claude",
        event: { type: "session", sessionId: "44444444-4444-4444-8444-444444444444" },
      },
    ];
    expect(findLastSessionIdForAgent(log, "codex")).toBeNull();
  });

  test("ignores non-session events while scanning", async () => {
    const { findLastSessionIdForAgent } = await import("#storage/conversations");
    const sid = "55555555-5555-4555-8555-555555555555";
    const log: ConversationEntry[] = [
      { ts: "t1", agent: "claude", event: { type: "session", sessionId: sid } },
      { ts: "t2", agent: "claude", event: { type: "text", content: "hello" } },
      {
        ts: "t3",
        agent: "claude",
        event: { type: "result", content: "hello", stopReason: "end_turn" },
      },
    ];
    // The trailing text/result events must not mask the session id.
    expect(findLastSessionIdForAgent(log, "claude")).toBe(sid);
  });
});
