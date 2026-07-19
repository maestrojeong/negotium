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
negotium serve otium     # separate shell
negotium -v
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

## Context warning policy

Embedding hosts can share Negotium's provider-neutral 80% context warning policy while adapting
the command guidance to their own capabilities:

```ts
import {
  claudeRequestContextTokens,
  createContextWarningState,
  nextContextWarning,
} from "negotium/runtime-helpers";

const warningState = createContextWarningState(); // owned by this host/runtime
const contextTokens = claudeRequestContextTokens(claudeMessageUsage);
const alert = nextContextWarning(warningState, {
  key: `${userId}:${topicId}`,
  topicTitle,
  usage: { contextTokens, contextWindow },
  supportsCompact: false, // legacy Otium currently guides users to /new only
});
```

Call `clearContextWarning(warningState, key)` when that consumer starts a fresh provider session.
The helper has no process-global dedupe state, so separate runtimes cannot suppress each other's
alerts.

## Shared runtime utilities

Small provider-neutral helpers that otherwise tend to drift between embedding hosts are also
available from the same public boundary:

```ts
import {
  deepMapStrings,
  delay,
  errorResult,
  errMsg,
  isSensitivePath,
  mcpError,
  mcpOk,
  parseUserIdArg,
  sanitizeFileName,
  sanitizeId,
  sanitizeTopicName,
  textResult,
  topicAppLink,
  topicMarkdownLink,
} from "negotium/runtime-helpers";
```

These exports are stateless or caller-owned. Process singleton utilities such as logging,
configuration, SQLite ownership, and outbox watchers remain excluded. Lifecycle reuse is available
only through `createLifecycleManager({ logger, process })`, which keeps handlers and signal hooks
owned by the embedding host.

Maintainers can measure source overlap against an embedding host and fail on regressions with:

```sh
bun run audit:runtime-overlap \
  --source=packages/core/src \
  --consumer=/path/to/otium/apps/runtime-api/src \
  --max-exact=10 --max-95=31 --max-80=55
```

The caps are upper bounds: removing wrappers makes the counts fall, while newly introduced copies
make the audit fail.

## MCP server factories

Embedding hosts can reuse tool registration while retaining ownership of storage and process
lifecycle. Factories never connect to stdio or parse global CLI arguments:

```ts
import { createTaskMcpServer } from "negotium/mcp-factories";

const taskServer = createTaskMcpServer(
  { userId, topic: topicTitle, topicId },
  {
    readTasks: (userId, scopeKey) => hostTasks.read(userId, scopeKey),
    writeTasks: (userId, scopeKey, tasks) =>
      hostTasks.write(userId, scopeKey, tasks),
  },
);
```

`createTokenStatsMcpServer({ userId }, host)` and `createSystemHealthMcpServer(host)` provide the
same boundary for usage statistics and system probes. The standalone Negotium CLI remains a thin
stdio entrypoint over these factories. More common MCP servers will move behind this host-injection
boundary incrementally.

Vault consumers must inject credential operations explicitly, so two embedding hosts cannot share
process-global Vault state accidentally:

```ts
import { createVaultMcpServer, protectMcpStdio } from "negotium/mcp-factories";

const vaultServer = createVaultMcpServer(
  { userId, httpOnly: true },
  {
    list: (id) => vault.list(id),
    substitute: (id, text) => vault.substitute(id, text),
    redact: (id, text) => vault.redact(id, text),
  },
);
```

`protectMcpStdio({ env, console })` is an opt-in standalone-entrypoint helper and returns an
idempotent restore function. Embedded transports should normally avoid changing process-wide
console behavior.

Wiki hosts inject both the filesystem root and the optional topic-brief bridge. Importing the
factory does not parse `process.argv`, open SQLite, or connect stdio:

```ts
import { createWikiMcpServer } from "negotium/mcp-factories";

const wikiServer = createWikiMcpServer(
  { userId, topicId, surface: "wiki" },
  {
    wikiRoot: hostWikiRoot,
    getTopicBrief: (id) => hostBriefs.get(id),
    setTopicBrief: (id, patch) => hostBriefs.set(id, patch),
  },
);
```

Long-lived hosts can also own an isolated background process manager:

```ts
import { createBackgroundBashManager } from "negotium/background-bash";

const backgroundBash = createBackgroundBashManager({
  env: hostEnvironment,
  basePort: 47_000,
  maxPort: 47_099,
});
```

Each manager owns its capability, server identity, reserved ports, process handles, and known
contexts. The root exports remain compatibility wrappers over Negotium's default manager.

## Agent host helpers

Embedding hosts can reuse pre-flight authentication, fork lifecycle, and task snapshot behavior
without copying provider files:

```ts
import {
  acquireCodexSpawnLock,
  checkAgentAuth,
  forkAgentSession,
  killCodexTrees,
  resolveTaskEventScope,
  withTaskSnapshots,
} from "negotium/agent-helpers";

const auth = checkAgentAuth("codex", hostAuth);
const scope = resolveTaskEventScope(queryOptions, hostTasks);
```

The host arguments own credential paths, environment checks, and task storage. Provider execution
itself remains available through `negotium/hosted-agent`.

Process-tree helpers are also exported from this subpath so an embedding runtime does not need a
copied `codex-tree-kill.ts`. Their ownership Set is process-local; use them only for Codex children
spawned by the current runtime process.

## Agent helper embedding API

Agent switching, task-stream snapshots, and session forks are available from one stable subpath:

```ts
import {
  checkAgentAuth,
  forkAgentSession,
  resolveTaskEventScope,
  withTaskSnapshots,
} from "negotium/agent-helpers";

const auth = checkAgentAuth("codex", hostAuth);
const scope = resolveTaskEventScope(queryOptions, hostTasks);
const events = scope ? withTaskSnapshots(providerEvents, scope, hostTasks) : providerEvents;
```

Supplying `AgentAuthHost` and `TaskEventHost` keeps auth paths, environment state, and task stores
owned by the embedding process. The default host remains available only as a convenience for the
standalone Negotium runtime.

## MCP catalog policy

`negotium/mcp-catalog` exposes transport-independent required/optional classification. Embedding
hosts can merge host-only capabilities without duplicating Negotium's built-in list:

```ts
import {
  classifyForumMcpServers,
  COMMON_RUNTIME_MCP_POLICY,
} from "negotium/mcp-catalog";

const policy = {
  ...COMMON_RUNTIME_MCP_POLICY,
  "cron-manager": { scopes: ["forum", "manager"], forumRequired: true },
};
const { required, optional } = classifyForumMcpServers(policy);
```

Playwright and background Bash are canonical required forum capabilities, so topic settings should
not present them as optional toggles. Host-only entries choose their own `forumRequired` policy.

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
