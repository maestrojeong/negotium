import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("daemon import boundaries", () => {
  test("agent dispatch does not statically load provider implementations", () => {
    const source = read("packages/core/src/agents/index.ts");
    expect(source).not.toMatch(/^import .*#agents\/(?:claude|codex|maestro)-provider/m);
    expect(source).not.toMatch(/^import .*maestro-agent-sdk/m);
    expect(source).toContain('await import("#agents/claude-provider")');
    expect(source).toContain('await import("#agents/codex-provider")');
    expect(source).toContain('await import("#agents/maestro-provider")');
  });

  test("registry metadata does not load the Maestro SDK", () => {
    expect(read("packages/core/src/agents/maestro-registry.ts")).not.toMatch(
      /^import .* from ["']maestro-agent-sdk["']/m,
    );
    expect(read("packages/core/src/topics/session.ts")).not.toMatch(
      /^import .* from ["']maestro-agent-sdk["']/m,
    );
    const probe = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        [
          'await import("./packages/core/src/agents/registry.ts")',
          'console.log(Object.keys(require.cache).filter((path) => path.includes("maestro-agent-sdk")).length)',
        ].join(";"),
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString().trim()).toBe("0");
  });

  test("node and MCP packages use narrow core host entrypoints", () => {
    for (const path of [
      "packages/node/src/index.ts",
      "packages/node/src/control.ts",
      "packages/node/src/files.ts",
      "packages/mcp/src/index.ts",
      "packages/mcp/src/server.ts",
      "packages/mcp/src/node-tools.ts",
      "packages/mcp/src/hosted-surfaces.ts",
    ]) {
      expect(read(path)).not.toMatch(/from ["']@negotium\/core["']/);
    }
  });

  test("canonical node checks join status before loading the Otium runtime", () => {
    for (const path of ["apps/cli/src/main.ts", "adapters/otium/src/cli.ts"]) {
      const source = read(path);
      expect(source.indexOf("join-status")).toBeGreaterThan(-1);
      expect(source.indexOf("join-status")).toBeLessThan(source.indexOf("node-runtime"));
    }
  });
});
