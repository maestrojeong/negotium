import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHost } from "#manager";
import { McpManifest } from "#manifest";
import type { McpServerSpec } from "#spec";

/**
 * Trivial HTTP server bound via the "{port}" arg placeholder. Bun.serve keeps
 * the process alive until it is signalled.
 */
const SERVE_SCRIPT =
  'Bun.serve({ port: {port}, hostname: "127.0.0.1", fetch: () => new Response("ok") });';

const noopLog = () => {};

function httpSpec(key: string, base: number, over?: Partial<McpServerSpec>): McpServerSpec {
  return {
    key,
    transport: "http",
    command: "bun",
    args: ["-e", SERVE_SCRIPT],
    portRange: { base, max: base + 9 },
    scope: "node",
    readyTimeoutMs: 15_000,
    ...over,
  };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await Bun.sleep(50);
  }
  return cond();
}

describe("McpHost", () => {
  let dir: string;
  let portsDir: string;
  let manifest: McpManifest;
  let host: McpHost;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-host-"));
    portsDir = join(dir, "run", "mcp-ports");
    manifest = new McpManifest({ file: join(dir, "data", "mcp-manifest.json") });
    host = new McpHost({ manifest, portsDir, log: noopLog, sweepIntervalMs: 100 });
  });

  afterEach(async () => {
    await host.stopAll();
  });

  test("ensure spawns an http server, waits ready, writes the port file", async () => {
    manifest.add(httpSpec("web", 43710));
    const inst = await host.ensure("web");

    expect(inst.key).toBe("web");
    expect(inst.instanceKey).toBe("node");
    expect(inst.pid).toBeGreaterThan(0);
    expect(inst.port).toBeGreaterThanOrEqual(43710);
    expect(inst.port).toBeLessThanOrEqual(43719);
    expect(inst.url).toBe(`http://127.0.0.1:${inst.port}`);

    // Actually reachable.
    const res = await fetch(inst.url!);
    expect(await res.text()).toBe("ok");

    // Port file written with the allocated port.
    const portFile = join(portsDir, "web--node");
    expect(readFileSync(portFile, "utf8").trim()).toBe(String(inst.port));

    expect(host.listRunning()).toHaveLength(1);
  });

  test("ensure reuses a live instance", async () => {
    manifest.add(httpSpec("web", 43720));
    const a = await host.ensure("web");
    const b = await host.ensure("web");
    expect(b.port).toBe(a.port);
    expect(b.pid).toBe(a.pid);
    expect(host.listRunning()).toHaveLength(1);
  });

  test("port allocation skips ports claimed by other port files", async () => {
    const base = 43730;
    mkdirSync(portsDir, { recursive: true });
    // Another instance's port file claims the first port of the range.
    writeFileSync(join(portsDir, "other--node"), String(base));

    manifest.add(httpSpec("web", base));
    const inst = await host.ensure("web");
    expect(inst.port).not.toBe(base);
    expect(inst.port).toBeGreaterThan(base);
    expect(inst.port).toBeLessThanOrEqual(base + 9);
  });

  test("stop kills the process and removes the port file", async () => {
    manifest.add(httpSpec("web", 43740));
    const inst = await host.ensure("web");
    const portFile = join(portsDir, "web--node");
    expect(existsSync(portFile)).toBe(true);

    expect(await host.stop("web")).toBe(true);
    expect(existsSync(portFile)).toBe(false);
    expect(host.listRunning()).toHaveLength(0);
    // Second stop is a no-op.
    expect(await host.stop("web")).toBe(false);

    // The server is gone.
    await expect(fetch(`http://127.0.0.1:${inst.port}`)).rejects.toThrow();
  });

  test("crash cleans registry and port file", async () => {
    manifest.add(httpSpec("web", 43750));
    const inst = await host.ensure("web");
    const portFile = join(portsDir, "web--node");

    process.kill(inst.pid!, "SIGKILL");
    expect(await waitFor(() => host.listRunning().length === 0, 3_000)).toBe(true);
    expect(existsSync(portFile)).toBe(false);
  });

  test("instance scope: requires instanceKey, isolates instances", async () => {
    manifest.add(httpSpec("web", 43760, { scope: "instance" }));
    await expect(host.ensure("web")).rejects.toThrow(/instanceKey is required/);

    const a = await host.ensure("web", "topic:a");
    const b = await host.ensure("web", "topic:b");
    expect(a.port).not.toBe(b.port);
    expect(host.listRunning()).toHaveLength(2);
    // instanceKey sanitized in port file names.
    expect(existsSync(join(portsDir, "web--topic_a"))).toBe(true);
    expect(existsSync(join(portsDir, "web--topic_b"))).toBe(true);

    expect(await host.stop("web", "topic:a")).toBe(true);
    expect(host.listRunning()).toHaveLength(1);
  });

  test("disabled and unknown specs refuse to launch", async () => {
    manifest.add(httpSpec("web", 43770));
    manifest.setEnabled("web", false);
    await expect(host.ensure("web")).rejects.toThrow(/disabled/);
    await expect(host.ensure("nope")).rejects.toThrow(/Unknown/);
  });

  test("stdio: ensure returns a pseudo-instance, buildAgentSpec returns command form", async () => {
    manifest.add({
      key: "echo",
      transport: "stdio",
      command: "bun",
      args: ["run", "echo-server.ts"],
      env: { FOO: "bar" },
      scope: "node",
    });

    const inst = await host.ensure("echo");
    expect(inst.key).toBe("echo");
    expect(inst.instanceKey).toBe("node");
    expect(inst.pid).toBeUndefined();
    expect(inst.port).toBeUndefined();
    expect(inst.url).toBeUndefined();
    expect(host.listRunning()).toHaveLength(0); // nothing spawned

    const agentSpec = await host.buildAgentSpec("echo", "sse");
    expect(agentSpec).toEqual({
      command: "bun",
      args: ["run", "echo-server.ts"],
      env: { FOO: "bar" },
    });
  });

  test("buildAgentSpec http: sse and streamable-http flavors", async () => {
    manifest.add(httpSpec("web", 43780));
    const sse = await host.buildAgentSpec("web", "sse");
    const inst = host.listRunning()[0];
    expect(sse).toEqual({ type: "sse", url: `http://127.0.0.1:${inst.port}/sse` });

    const http = await host.buildAgentSpec("web", "http");
    expect(http).toEqual({ url: `http://127.0.0.1:${inst.port}/mcp` });
    // buildAgentSpec reused the same instance.
    expect(host.listRunning()).toHaveLength(1);
  });

  test("sweeper evicts idle instances", async () => {
    manifest.add(httpSpec("web", 43790, { idleEvictMs: 300 }));
    await host.ensure("web");
    const portFile = join(portsDir, "web--node");
    expect(existsSync(portFile)).toBe(true);

    const stopSweeper = host.startSweeper();
    try {
      expect(await waitFor(() => host.listRunning().length === 0, 3_000)).toBe(true);
      expect(existsSync(portFile)).toBe(false);
    } finally {
      stopSweeper();
    }
  });

  test("touch defers idle eviction", async () => {
    manifest.add(httpSpec("web", 43800, { idleEvictMs: 400 }));
    await host.ensure("web");
    const stopSweeper = host.startSweeper();
    try {
      // Keep touching for a full eviction window — instance must survive.
      for (let i = 0; i < 4; i++) {
        await Bun.sleep(150);
        host.touch("web");
      }
      expect(host.listRunning()).toHaveLength(1);
      // Stop touching — it must get evicted.
      expect(await waitFor(() => host.listRunning().length === 0, 3_000)).toBe(true);
    } finally {
      stopSweeper();
    }
  });

  test("ensure fails when the command never binds the port", async () => {
    manifest.add({
      key: "dud",
      transport: "http",
      command: "bun",
      args: ["-e", "await Bun.sleep(60_000);"], // never binds
      portRange: { base: 43810, max: 43812 },
      scope: "node",
      readyTimeoutMs: 1_000,
    });
    await expect(host.ensure("dud")).rejects.toThrow(/not ready/);
    expect(host.listRunning()).toHaveLength(0);
    expect(existsSync(join(portsDir, "dud--node"))).toBe(false);
  });
});
