# @negotium/node

Composable Negotium node host. It owns the loopback runtime/MCP server, inbox worker, managed MCP
processes, optional modules such as Cron, and coordinated shutdown.

```bash
bun add @negotium/node
```

```ts
import { startDefaultNode } from "@negotium/node";

const node = await startDefaultNode({ advertise: true, singleton: true });
console.log(node.port);
process.once("SIGINT", () => void node.stop());
await node.completed;
```

Within one embedding process, share a single node handle instead of starting one per adapter. The
first-party CLI currently runs Telegram and Otium as separate leased host processes that coordinate
through the same SQLite state, while Terminal clients connect to one advertised long-lived node.

Start at most one advertised node per `NEGOTIUM_STATE_DIR`. It writes mode-0600 connection metadata
under the state run directory and exposes an authenticated REST/SSE control surface on
`127.0.0.1`. The state-directory bearer token is stored separately as `node-control-token`; a
SQLite process lease prevents duplicate daemon ownership.
