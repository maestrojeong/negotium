import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeAtToken, completePathToken, pathSuggestions } from "@/path-suggest";

const root = mkdtempSync(join(tmpdir(), "negotium-pathsuggest-"));
mkdirSync(join(root, "alpha"));
mkdirSync(join(root, "beta"));
writeFileSync(join(root, "app.ts"), "");
writeFileSync(join(root, "apple.txt"), "");
writeFileSync(join(root, ".hidden"), "");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("activeAtToken", () => {
  test("detects a trailing @token at line start or after whitespace", () => {
    expect(activeAtToken("@foo", 4)).toEqual({ start: 0, frag: "foo" });
    expect(activeAtToken("look at @~/x", 12)).toEqual({ start: 8, frag: "~/x" });
    expect(activeAtToken("@", 1)).toEqual({ start: 0, frag: "" });
  });

  test("ignores @ that is not a standalone token (e.g. emails)", () => {
    expect(activeAtToken("mail me a@b.com", 15)).toBeNull();
  });

  test("only completes the token the cursor sits in", () => {
    // Cursor before the @ → no active token.
    expect(activeAtToken("@foo bar", 8)).toBeNull();
  });
});

describe("pathSuggestions", () => {
  test("lists a directory's entries, directories first", () => {
    const result = pathSuggestions(`@${root}/`, `@${root}/`.length);
    expect(result).not.toBeNull();
    const labels = result?.items.map((item) => item.label) ?? [];
    // dirs (alpha/, beta/) precede files (app.ts, apple.txt); .hidden excluded.
    expect(labels).toEqual(["alpha/", "beta/", "app.ts", "apple.txt"]);
  });

  test("filters by the basename prefix", () => {
    const token = `@${root}/app`;
    const result = pathSuggestions(token, token.length);
    expect(result?.items.map((item) => item.label)).toEqual(["app.ts", "apple.txt"]);
  });

  test("hides dotfiles unless the prefix is a dot", () => {
    const dotToken = `@${root}/.`;
    const result = pathSuggestions(dotToken, dotToken.length);
    expect(result?.items.map((item) => item.label)).toEqual([".hidden"]);
  });

  test("caps results and reports how many were trimmed", () => {
    const big = mkdtempSync(join(tmpdir(), "negotium-pathsuggest-big-"));
    for (let i = 0; i < 20; i += 1) writeFileSync(join(big, `file-${i}.txt`), "");
    try {
      const token = `@${big}/`;
      const result = pathSuggestions(token, token.length);
      expect(result?.items.length).toBe(8);
      expect(result?.truncated).toBe(12);
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });

  test("returns an empty list (not null) for a nonexistent directory", () => {
    const token = "@/no/such/dir/here";
    const result = pathSuggestions(token, token.length);
    expect(result).not.toBeNull();
    expect(result?.items).toEqual([]);
  });

  test("returns null when no @token is active", () => {
    expect(pathSuggestions("plain text", 10)).toBeNull();
  });
});

describe("completePathToken", () => {
  test("replaces the @token and appends a slash for directories", () => {
    const token = `@${root}/al`;
    const result = pathSuggestions(token, token.length);
    const dir = result?.items.find((item) => item.isDir);
    expect(dir).toBeDefined();
    const completed = completePathToken(token, token.length, dir!);
    expect(completed?.line).toBe(`${root}/alpha/`);
    expect(completed?.col).toBe(`${root}/alpha/`.length);

    const drilling = completePathToken(token, token.length, dir!, { keepTrigger: true });
    expect(drilling?.line).toBe(`@${root}/alpha/`);
  });

  test("keeps surrounding text intact when completing mid-line", () => {
    const prefix = "see @";
    const suffix = " thanks";
    const dirToken = `@${root}/be`;
    const line = `see @${root}/be thanks`;
    const col = prefix.length + `${root}/be`.length; // cursor right after "be"
    const result = pathSuggestions(dirToken, dirToken.length);
    const beta = result?.items.find((item) => item.label === "beta/");
    const completed = completePathToken(line, col, beta!);
    expect(completed?.line).toBe(`see ${root}/beta/${suffix}`);
  });
});
