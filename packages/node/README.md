# @negotium/node

Composable Negotium node host. It owns the loopback runtime/MCP server, inbox worker, managed MCP
processes, optional modules such as Cron, and coordinated shutdown.

```ts
import { startDefaultNode } from "@negotium/node";

const node = await startDefaultNode();
console.log(node.port);
await node.stop();
```

Start one node per `NEGOTIUM_STATE_DIR`. Multiple adapters should attach to this one handle rather
than each starting another node.
