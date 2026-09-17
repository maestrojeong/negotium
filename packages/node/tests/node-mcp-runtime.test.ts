import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNodeMcpServers, setNodeMcpServers } from "@negotium/core/node-host";
import { McpHost, McpManifest, type McpServerSpec } from "@negotium/mcp-host";
import { wireNodeMcps } from "../src/index";

const SERVE_SCRIPT =
  'Bun.serve({ port: {port}, hostname: "127.0.0.1", fetch: () => new Response("ok") });';

describe("node MCP runtime wiring", () => {
  let host: McpHost | undefined;

  afterEach(async () => {
    setNodeMcpServers([]);
    await host?.stopAll();
    host = undefined;
  });

  test("keeps instance-scoped HTTP specs lazy and reconciles their removal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "node-mcp-runtime-"));
    const file = join(dir, "mcp-manifest.json");
    const manifest = new McpManifest({ file });
    const spec: McpServerSpec = {
      key: "linear",
      transport: "http",
      command: "bun",
      args: ["-e", SERVE_SCRIPT],
      portRange: { base: 45400, max: 45409 },
      scope: "instance",
      readyTimeoutMs: 15_000,
    };
    manifest.add(spec);
    host = new McpHost({ manifest, portsDir: join(dir, "ports"), log: () => {} });

    expect(await wireNodeMcps(host, manifest)).toEqual({ active: ["linear"], failed: [] });
    expect(host.listRunning()).toEqual([]);

    const entry = getNodeMcpServers()[0];
    expect(entry?.kind).toBe("http-instance");
    if (!entry || entry.kind !== "http-instance") throw new Error("missing instance entry");
    const firstPort = await entry.ensurePort("topic-a");
    const secondPort = await entry.ensurePort("topic-b");
    expect(firstPort).not.toBe(secondPort);
    expect(
      host
        .listRunning()
        .map((instance) => instance.instanceKey)
        .sort(),
    ).toEqual(["topic-a", "topic-b"]);

    const writer = new McpManifest({ file });
    writer.remove("linear");
    expect(await wireNodeMcps(host, manifest, { reload: true })).toEqual({
      active: [],
      failed: [],
    });
    expect(host.listRunning()).toEqual([]);
    expect(getNodeMcpServers()).toEqual([]);

    writer.add({
      ...spec,
      key: "singleton",
      scope: "node",
      portRange: { base: 45410, max: 45419 },
    });
    expect(await wireNodeMcps(host, manifest, { reload: true })).toEqual({
      active: ["singleton"],
      failed: [],
    });
    expect(host.listRunning()).toHaveLength(1);
    expect(host.listRunning()[0]?.instanceKey).toBe("node");

    writer.setEnabled("singleton", false);
    expect(await wireNodeMcps(host, manifest, { reload: true })).toEqual({
      active: [],
      failed: [],
    });
    expect(host.listRunning()).toEqual([]);
  });
});
