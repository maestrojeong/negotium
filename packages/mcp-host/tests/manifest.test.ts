import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManifest } from "#manifest";
import type { McpServerSpec } from "#spec";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "mcp-manifest-")), "mcp-manifest.json");
}

const stdioSpec: McpServerSpec = {
  key: "echo",
  transport: "stdio",
  command: "bun",
  args: ["run", "echo-server.ts"],
  env: { FOO: "bar" },
  scope: "node",
};

const httpSpec: McpServerSpec = {
  key: "web",
  transport: "http",
  command: "bun",
  args: ["-e", "serve({port: {port}})"],
  portRange: { base: 43000, max: 43010 },
  scope: "instance",
  idleEvictMs: 60_000,
};

describe("McpManifest", () => {
  test("add / get / list / remove", () => {
    const m = new McpManifest({ file: tmpFile() });
    expect(m.list()).toEqual([]);
    expect(m.get("echo")).toBeUndefined();

    m.add(stdioSpec);
    m.add(httpSpec);
    expect(m.list().map((s) => s.key)).toEqual(["echo", "web"]);
    expect(m.get("echo")?.command).toBe("bun");
    expect(m.get("web")?.portRange).toEqual({ base: 43000, max: 43010 });

    expect(m.remove("echo")).toBe(true);
    expect(m.remove("echo")).toBe(false);
    expect(m.get("echo")).toBeUndefined();
    expect(m.list().map((s) => s.key)).toEqual(["web"]);
  });

  test("add throws on duplicate key", () => {
    const m = new McpManifest({ file: tmpFile() });
    m.add(stdioSpec);
    expect(() => m.add({ ...stdioSpec })).toThrow(/already exists/);
  });

  test("validates specs: http requires portRange, keys must be path-safe", () => {
    const m = new McpManifest({ file: tmpFile() });
    expect(() => m.add({ ...httpSpec, key: "no-range", portRange: undefined })).toThrow();
    expect(() =>
      m.add({ ...httpSpec, key: "bad-range", portRange: { base: 43010, max: 43000 } }),
    ).toThrow();
    expect(() => m.add({ ...stdioSpec, key: "bad/key" })).toThrow();
    expect(() => m.add({ ...stdioSpec, key: ".." })).toThrow();
  });

  test("enable / disable", () => {
    const m = new McpManifest({ file: tmpFile() });
    m.add(stdioSpec);
    expect(m.isEnabled("echo")).toBe(true);
    m.setEnabled("echo", false);
    expect(m.isEnabled("echo")).toBe(false);
    // Disabled specs stay listed.
    expect(m.list().map((s) => s.key)).toEqual(["echo"]);
    m.setEnabled("echo", true);
    expect(m.isEnabled("echo")).toBe(true);
    expect(m.isEnabled("nope")).toBe(false);
    expect(() => m.setEnabled("nope", true)).toThrow(/Unknown/);
  });

  test("persists across instances", () => {
    const file = tmpFile();
    const a = new McpManifest({ file });
    a.add(stdioSpec);
    a.add(httpSpec);
    a.setEnabled("web", false);

    const b = new McpManifest({ file });
    expect(b.list().map((s) => s.key)).toEqual(["echo", "web"]);
    expect(b.get("web")?.command).toBe("bun");
    expect(b.isEnabled("echo")).toBe(true);
    expect(b.isEnabled("web")).toBe(false);

    // remove persists too
    b.remove("echo");
    const c = new McpManifest({ file });
    expect(c.list().map((s) => s.key)).toEqual(["web"]);
  });

  test("throws on corrupt manifest file instead of clobbering it", () => {
    const file = tmpFile();
    const m = new McpManifest({ file });
    m.add(stdioSpec);
    // Corrupt the file on disk.
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.slice(0, 10));
    expect(() => new McpManifest({ file })).toThrow(/Invalid MCP manifest/);
  });
});
