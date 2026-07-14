import { describe, expect, test } from "bun:test";
import { sanitizeFileName, sanitizeId, sanitizeTopicName } from "#security/sanitize";

describe("sanitizeTopicName", () => {
  test("keeps ASCII letters, digits, Korean, underscore, hyphen", () => {
    expect(sanitizeTopicName("maestro_123-네이버")).toBe("maestro_123-네이버");
  });

  test("replaces slashes and dots", () => {
    // "../../etc/passwd" — 2 dots, 1 slash, 2 dots, 1 slash before "etc" = 6 underscores
    expect(sanitizeTopicName("../../etc/passwd")).toBe("______etc_passwd");
  });

  test("replaces tilde and backslash", () => {
    expect(sanitizeTopicName("~/home\\bin")).toBe("__home_bin");
  });

  test("replaces whitespace and control chars", () => {
    expect(sanitizeTopicName("hello world\n\t")).toBe("hello_world__");
  });

  test("returns '_' on empty input", () => {
    expect(sanitizeTopicName("")).toBe("_");
  });

  test("returns '_' when input is all disallowed chars", () => {
    expect(sanitizeTopicName("🙂🎉")).toMatch(/^_+$/);
  });

  test("lowercase=true lowercases ASCII (Korean unaffected)", () => {
    expect(sanitizeTopicName("HelloWorld-네이버", true)).toBe("helloworld-네이버");
  });
});

describe("sanitizeFileName", () => {
  test("keeps __KEEP_MAESTRONUMERIC__, dot, underscore, hyphen", () => {
    expect(sanitizeFileName("report_v2.pdf")).toBe("report_v2.pdf");
  });

  test("replaces slashes but keeps dots", () => {
    expect(sanitizeFileName("../secret.txt")).toBe(".._secret.txt");
  });

  test("blocks pure '..' traversal reference", () => {
    expect(sanitizeFileName("..")).toBe("_");
  });

  test("blocks pure '.' traversal reference", () => {
    expect(sanitizeFileName(".")).toBe("_");
  });

  test("keeps '..'-prefixed names like '..foo' (single path component)", () => {
    // "..foo" is a valid filename, not a parent-dir reference
    expect(sanitizeFileName("..foo")).toBe("..foo");
  });

  test("returns '_' on empty input", () => {
    expect(sanitizeFileName("")).toBe("_");
  });
});

describe("sanitizeId", () => {
  test("strips dots (not allowed for IDs)", () => {
    expect(sanitizeId("ctx.123.v2")).toBe("ctx_123_v2");
  });

  test("keeps underscore and hyphen", () => {
    expect(sanitizeId("abc_def-ghi")).toBe("abc_def-ghi");
  });

  test("replaces path separators", () => {
    expect(sanitizeId("../../secret")).toBe("______secret");
  });

  test("returns '_' on empty input", () => {
    expect(sanitizeId("")).toBe("_");
  });
});
