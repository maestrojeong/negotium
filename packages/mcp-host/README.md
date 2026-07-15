# @negotium/mcp-host

Process manager for MCP servers hosted by a Negotium node. It owns the MCP manifest, transport
selection, loopback port allocation, health checks, idle eviction, and coordinated shutdown.

```bash
bun add @negotium/mcp-host
```

```ts
import { McpHost, McpManifest } from "@negotium/mcp-host";

const manifest = new McpManifest();
manifest.add({
  key: "example",
  transport: "stdio",
  command: "bunx",
  args: ["example-mcp-server"],
  scope: "node",
});

const host = new McpHost({ manifest });
await host.ensure("example");
await host.stopAll();
```

Most applications should install `@negotium/node`, which wires this package to the runtime.
Requires Bun 1.2.15 or newer.
