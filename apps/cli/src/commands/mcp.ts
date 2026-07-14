/** `negotium mcp <list|add|remove|enable|disable>` — per-node MCP manifest. */

import { McpManifest, mcpServerSpecSchema } from "@negotium/mcp-host";

export function mcpCommand(args: string[]): void {
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
            '"args":["mcp-patchright","--port","{port}"],"portRange":{"base":9100,"max":9199},"scope":"instance"}\'',
        );
        process.exitCode = 1;
        return;
      }
      const spec = mcpServerSpecSchema.parse(JSON.parse(raw));
      manifest.add(spec);
      console.log(`added "${spec.key}" to this node's manifest`);
      return;
    }
    case "remove": {
      const key = rest[0];
      if (!key) {
        console.error("usage: negotium mcp remove <key>");
        process.exitCode = 1;
        return;
      }
      console.log(manifest.remove(key) ? `removed "${key}"` : `no such key "${key}"`);
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
      return;
    }
    default:
      console.error(`unknown subcommand "${sub}" — use list|add|remove|enable|disable`);
      process.exitCode = 1;
  }
}
