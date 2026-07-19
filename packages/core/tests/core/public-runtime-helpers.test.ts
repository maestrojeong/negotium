import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killCodexTrees, snapshotCodexChildren } from "#agents/public-helpers";
import {
  deepMapStrings,
  delay,
  errMsg,
  errorResult,
  isSensitivePath,
  mcpError,
  mcpOk,
  parseUserIdArg,
  sanitizeFileName,
  sanitizeId,
  sanitizeTopicName,
  textResult,
  topicAppLink,
  topicMarkdownLink,
  writeJsonFileAtomic,
} from "#runtime/public-helpers";

describe("public runtime helpers", () => {
  test("agent process helpers are exposed without starting a process", () => {
    expect(snapshotCodexChildren()).toBeInstanceOf(Map);
    expect(() => killCodexTrees([])).not.toThrow();
  });
  test("exports the shared error, delay, and deep-map behavior", async () => {
    expect(errMsg(new Error("boom"))).toBe("boom");
    expect(errMsg("boom", "fallback")).toBe("fallback");
    expect(deepMapStrings({ nested: ["a", 1] }, (value) => value.toUpperCase())).toEqual({
      nested: ["A", 1],
    });
    await expect(delay(0)).resolves.toBeUndefined();
  });

  test("exports path component sanitizers through the consumer boundary", () => {
    expect(sanitizeTopicName("Hello world", true)).toBe("hello_world");
    expect(sanitizeFileName("..")).toBe("_");
    expect(sanitizeId("ctx.123")).toBe("ctx_123");
    expect(isSensitivePath("/tmp/project/.env.production")).toBeTrue();
  });

  test("exports MCP response and topic-link helpers", () => {
    expect(textResult("ok")).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(errorResult("bad")).toEqual({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });
    expect(mcpOk("ok")).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(mcpError("bad")).toEqual({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });
    expect(parseUserIdArg(["--user-id=user_1"])).toBe("user_1");
    expect(parseUserIdArg(["--user-id=../secret"])).toBe("");
    expect(topicAppLink("a/b")).toBe("otium://topic/a%2Fb");
    expect(topicMarkdownLink("a/b")).toBe("[Open topic](otium://topic/a%2Fb)");
  });

  test("exports the durable atomic JSON writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "runtime-helper-json-"));
    const file = join(dir, "state.json");
    try {
      writeJsonFileAtomic(file, { version: 1 });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
