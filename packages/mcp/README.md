# @negotium/mcp

Negotium's runtime MCP server and node-control tools. Mount one server to expose sessions,
subagents, shared tasks, wiki/skills, vault operations, and managed MCP configuration to an agent
host.

```ts
import { buildNegotiumMcpServer, handleNegotiumMcpRequest } from "@negotium/mcp";
```

Most applications should install `@negotium/node`, which starts this server with the correct
runtime lifecycle. Requires Bun 1.2.15 or newer.
