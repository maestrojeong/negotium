import { describe, expect, test } from "bun:test";
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
} from "#runtime/public-helpers";

describe("public runtime helpers", () => {
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
});
