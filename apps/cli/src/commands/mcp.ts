/** `negotium mcp <list|add|remove|enable|disable|reload>` — per-node MCP manifest. */

import { McpManifest, mcpServerSpecSchema } from "@negotium/mcp-host";
import { reloadNodeMcpManifest } from "@negotium/node";

async function applyManifestToRunningNode(): Promise<void> {
  const result = await reloadNodeMcpManifest();
  if (result === null) {
    console.log("node is not running; manifest changes apply on the next start");
    return;
  }
  if (!result.ok) throw new Error(`live MCP reload failed: ${result.error}`);
  console.log(
    `reloaded running node (${result.active.length > 0 ? result.active.join(", ") : "no active custom servers"})`,
  );
  if (result.failed.length > 0) {
    for (const failure of result.failed) {
      console.error(`failed to start "${failure.key}": ${failure.error}`);
    }
    process.exitCode = 1;
  }
}

export async function mcpCommand(args: string[]): Promise<void> {
  const manifest = new McpManifest();
  const [sub, ...rest] = args;

  switch (sub) {
    case undefined:
    case "list": {
      const specs = manifest.list();
      if (specs.length === 0) {
        console.log("no MCP servers assigned to this node yet — `negotium mcp add '<json>'`");
        return;
      }
      for (const spec of specs) {
        const enabled = manifest.isEnabled(spec.key) ? "on " : "off";
        const where =
          spec.transport === "http"
            ? `http :${spec.portRange?.base}-${spec.portRange?.max}`
            : "stdio";
        console.log(
          `[${enabled}] ${spec.key}  ${where}  ${spec.command} ${spec.args?.join(" ") ?? ""}`,
        );
      }
      return;
    }
    case "add": {
      const raw = rest.join(" ").trim();
      if (!raw) {
        console.error(
          'usage: negotium mcp add \'{"key":"browser","transport":"http","command":"bunx",' +
            '"args":["browser-rs","--port","{port}"],"portRange":{"base":9100,"max":9199},"scope":"instance"}\'',
        );
        process.exitCode = 1;
        return;
      }
      const spec = mcpServerSpecSchema.parse(JSON.parse(raw));
      manifest.add(spec);
      console.log(`added "${spec.key}" to this node's manifest`);
      await applyManifestToRunningNode();
      return;
    }
    case "remove": {
      const key = rest[0];
      if (!key) {
        console.error("usage: negotium mcp remove <key>");
        process.exitCode = 1;
        return;
      }
      const removed = manifest.remove(key);
      console.log(removed ? `removed "${key}"` : `no such key "${key}"`);
      if (removed) await applyManifestToRunningNode();
      return;
    }
    case "enable":
    case "disable": {
      const key = rest[0];
      if (!key) {
        console.error(`usage: negotium mcp ${sub} <key>`);
        process.exitCode = 1;
        return;
      }
      manifest.setEnabled(key, sub === "enable");
      console.log(`${sub}d "${key}"`);
      await applyManifestToRunningNode();
      return;
    }
    case "reload": {
      await applyManifestToRunningNode();
      return;
    }
    default:
      console.error(`unknown subcommand "${sub}" — use list|add|remove|enable|disable|reload`);
      process.exitCode = 1;
  }
}
