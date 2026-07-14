# @negotium/mcp-host

Process manager for MCP servers hosted by a Negotium node. It owns the MCP manifest, transport
selection, loopback port allocation, health checks, idle eviction, and coordinated shutdown.

```ts
import { McpHost, McpManifest } from "@negotium/mcp-host";
```

Most applications should install `@negotium/node`, which wires this package to the runtime.
Requires Bun 1.2.15 or newer.
