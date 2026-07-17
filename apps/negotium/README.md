# negotium

The one-command installer for the complete Negotium multi-agent node. The package includes the CLI,
runtime, MCP services, Cron module, and first-party Terminal, Telegram, and Otium adapters.

Requires Bun 1.2.15 or newer on macOS or Linux, plus credentials for Claude, Codex, or Maestro.

```bash
npm install --global negotium

negotium init
negotium terminal
negotium status
negotium stop
negotium telegram
negotium otium join <invite-code>
negotium start terminal
negotium start telegram  # separate shell
negotium start otium     # separate shell
```

Authenticate Claude with `claude`, Codex with `codex login`, or Maestro with
`DEEPSEEK_API_KEY`. See the [main repository](https://github.com/maestrojeong/negotium) for
configuration, security guidance, and architecture.

## Hosted execution API

Embedding control planes can configure and invoke Negotium's provider execution layer without
importing package internals:

```ts
import {
  configureAgentExecutionHost,
  runHostedAgent,
  type AgentExecutionHost,
  type AgentQueryOptions,
  type UnifiedEvent,
} from "negotium/hosted-agent";

import {
  canonicalMcpBridgeEnv,
  registerCanonicalMcpBridgeEnvProvider,
  revokeCanonicalMcpBridgeTurn,
} from "negotium/canonical-mcp-bridge";
```

These subpaths are the stable public boundary. Paths under `negotium/dist/` are package internals
and may change between releases.

## Storage embedding API

Embedding hosts can reuse Negotium's SQLite and filesystem stores without importing package
internals:

```ts
import { Database } from "bun:sqlite";
import {
  configureStorageHost,
  getTopic,
  sessionAsks,
  tasks,
} from "negotium/storage";

const database = new Database("/srv/otium/state/sessions.db", { create: true });
const restoreStorageHost = configureStorageHost({
  database,
  dataDir: "/srv/otium/state/data",
  logDir: "/srv/otium/logs",
  sessionAsksDir: "/srv/otium/state/run/session-asks",
  workspaceDir: "/srv/otium/state/workspace",
  sharedWikiDir: "/srv/otium/state/workspace/wiki",
  usersLogDir: "/srv/otium/state/data/users",
});

getTopic("topic-id");
sessionAsks.listPendingAsksForCaller({ userId: "user-id", from: "caller" });
tasks.readTasks("user-id", "topic-id");

restoreStorageHost();
database.close();
```

Configuration and schema setup are lazy. An injected database is borrowed: Negotium initializes
the required tables on first access but never closes that connection. Omitted fields use the same
`NEGOTIUM_*` paths as the standalone runtime. Injected paths are resolved to absolute paths when
configured, `undefined` fields leave earlier layers unchanged, and `resetStorageHost()` explicitly
returns every field to standalone fallbacks. Disposers are idempotent and safe even when called out
of order. `workspaceDir` owns the default shared `wiki/` subtree; `sharedWikiDir` and `usersLogDir`
can override those exact roots. `sessionAsksDir` is the root above per-user directories.
The `database` option is structural and accepts both `bun:sqlite.Database` and the Node-compatible
SQLite shim surface (`query`/`prepare`/`exec`/`run`/`transaction`) through
`StorageDatabaseInput`; ownership remains with the host. `StorageDatabase` describes the stable,
typed facade returned as `db`.

The facade exposes both direct functions and collision-safe module namespaces such as
`apiTopics.getTopicByName` and `forum.getTopicByName`; the direct forum alias is
`getForumTopicByName`. Pending session asks use bounded `v3-<sha256>` filenames and migrate live v2
and legacy records on access. Unsafe or oversized user IDs and token-stat IDs are stored under
stable SHA-256 components.
