# @negotium/mcp

Negotium's runtime MCP server and node-control tools. Mount one server to expose sessions,
subagents, shared tasks, wiki/skills, vault operations, and managed MCP configuration to an agent
host.

```bash
bun add @negotium/mcp
```

```ts
import { handleNegotiumMcpRequest } from "@negotium/mcp";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7777,
  async fetch(request) {
    return (await handleNegotiumMcpRequest(request)) ?? new Response("Not found", { status: 404 });
  },
});

console.log(`MCP server listening on 127.0.0.1:${server.port}`);
```

Most applications should install `@negotium/node`, which starts this server with the correct
runtime lifecycle. Requires Bun 1.2.15 or newer.
