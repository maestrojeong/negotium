# @negotium/node

Composable Negotium node host. It owns the loopback runtime/MCP server, inbox worker, managed MCP
processes, optional modules such as Cron, and coordinated shutdown.

```ts
import { startDefaultNode } from "@negotium/node";

const node = await startDefaultNode({ advertise: true, singleton: true });
console.log(node.port);
await node.completed;
await node.stop();
```

Start one node per `NEGOTIUM_STATE_DIR`. Multiple adapters should attach to this one handle rather
than each starting another node. An advertised node writes mode-0600 connection metadata under the
state run directory and exposes an authenticated REST/SSE control surface on `127.0.0.1`. The
state-directory bearer token is stored separately as `node-control-token`; a SQLite process lease
prevents duplicate daemon ownership.
