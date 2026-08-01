# Otium runtime deduplication

This document fixes the public integration boundary used to remove duplicated runtime code from
Otium. Every factory described here is part of the 0.1.39 package contract unless the extraction
table explicitly marks the module as a downstream keep.

## 0.1.39 immediate migrations

Only import package subpaths. Do not import files from `dist/runtime` or `@negotium/core`.

### Browser lifecycle

Import from `negotium/browser-runtime` and configure the host before node startup:

```ts
interface BrowserProxyConfig {
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

interface PlaywrightProfileBinding {
  readonly instanceKey: string;
  readonly ownerId: string;
  readonly profile: string;
}

interface PlaywrightChildEnvironmentContext {
  instanceKey: string;
  ownerId: string;
  capability: string;
  proxy: BrowserProxyConfig | null;
  browserRsBin?: string;
  environment: NodeJS.ProcessEnv;
}

interface PlaywrightManagerHost {
  readonly portsDir: string;
  readonly basePort: number;
  readonly maxPort: number;
  readonly browserBin: string;
  readonly browserRsBin?: string;
  readonly resolveProxy: () => BrowserProxyConfig | null;
  readonly resolveTopicBinding:
    (userId: string, topic?: string) => PlaywrightProfileBinding;
  readonly resolveNamedBinding:
    (ownerId: string, rawProfile: string) => PlaywrightProfileBinding;
  readonly resolveInstanceDataDir: (instanceKey: string) => string;
  readonly createChildEnvironment:
    (context: PlaywrightChildEnvironmentContext) => NodeJS.ProcessEnv;
  readonly cleanupBrowserProcessesForDataDir: (userDataDir: string) => void;
  readonly reapOrphanBrowsers: (liveUserDataDirs: Iterable<string>) => void;
}
```

`ownerId` is the canonical profile owner returned by the binding, not necessarily the requesting
user. A custom `resolveInstanceDataDir` requires both cleanup callbacks. Returned host and binding
objects are frozen. Partial configuration extends the current host and is rejected while instances
are active, spawning, or borrowed.

Use `withPlaywrightProfileMaintenance` to stop a live profile and delete or replace its directory
under one lifecycle barrier. See [Browser runtime](./BROWSER-RUNTIME.md) for the full lifecycle and
capability contract.

### Tool formatting

Import from `negotium/agent-helpers`:

```ts
type ToolCallSummaryValue =
  | string
  | number
  | boolean
  | Array<{ label: string; description?: string }>;
type ToolCallSummaryInput = Record<string, ToolCallSummaryValue>;

formatToolUse(name: string, input: Record<string, unknown>): string;
summarizeToolInput(
  name: string,
  input: Record<string, unknown>,
  options?: { cwd?: string },
): ToolCallSummaryInput | undefined;
summarizeShellCommand(value: string): string;
classifyShellToolName(value: string): "Bash" | "Read" | "Search";
```

The formatter is presentation-only. Callers retain ownership of event persistence, localization,
and UI delivery.

### Query state

Import from `negotium/query-runtime`:

```ts
interface QueryStateStoreLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

interface QueryStateStoreOptions {
  usersLogDir: string;
  logger?: QueryStateStoreLogger;
  sanitizeTopicId?: (topicId: string) => string;
}

interface QueryStateStore {
  write(userId: number | string, topicId: string, topicName: string, task?: string): void;
  clear(userId: number | string, topicId: string, legacyTopicName?: string): void;
}

createQueryStateStore(options: QueryStateStoreOptions): QueryStateStore;
```

The store writes `<usersLogDir>/<userId>/active-queries/<sanitized-topic-id>.json` atomically.
`clear` also accepts a legacy topic name so downstream migration can remove the old filename.

## Prompt builder factory

The shared prompt policy remains owned by Negotium. A downstream host may supply templates and
product sections through a factory; it may not replace the runtime-policy builder wholesale.

```ts
type SessionPromptKind = "topic" | "channel" | "manager";
type PromptSectionSlot =
  | "after-runtime-tools"
  | "after-shared-tasks"
  | "before-session-communication"
  | "after-session-communication"
  | "before-topic-configuration"
  | "after-topic-configuration"
  | "after-system-prompt";

interface PromptSectionContext extends SessionSystemPromptOpts {
  sessionKind: SessionPromptKind;
}

interface PromptExtraSection {
  id: string;
  slot: PromptSectionSlot;
  order?: number;
  render(context: PromptSectionContext): string | null | undefined;
}

interface PromptTemplateRequest {
  kind: "topic-system" | "channel-system" | "manager-system" | "visual-design";
  filename: string;
  fallback: string;
}

interface PromptBuilderHost {
  loadTemplate(request: PromptTemplateRequest): string | null | undefined;
  extraSections?: readonly PromptExtraSection[];
}

createPromptBuilders(host: PromptBuilderHost): {
  buildTopicSystemPrompt(options: SessionSystemPromptOpts): string;
  buildChannelSystemPrompt(options: SessionSystemPromptOpts): string;
  buildManagerSystemPrompt(options: SessionSystemPromptOpts): string;
};
```

Slots are emitted in the declared order above. Sections in one slot are sorted by `order` and then
`id`; duplicate IDs are rejected. Empty sections are omitted. Template variables remain
`AI_LABEL`, `TOPIC_TITLE`, `WORKSPACE_CWD`, and `UPLOADS_DIR`; unknown variables are left intact so a
host can detect configuration mistakes in snapshots. Template loading and caching are scoped to one
factory instance.

Otium should provide `Copyable Drafts` in `after-shared-tasks`. Visual and file-delivery policy
should use the existing `visualTools` and `fileDeliveryTools` gates; extra sections are only for
product wording not represented by those gates. Memory paths remain explicit inputs to
`buildMemoryPromptSection`, so the factory does not read downstream storage.

### Prompt migration acceptance

Golden snapshots must cover:

- topic, channel, and manager sessions;
- Claude, Codex, and Maestro;
- visual and file delivery enabled and disabled;
- ordinary, direct-child, and staged-subagent policy;
- resolved model and effort values;
- manager and topic memory with and without a latest summary.

Normalize workspace and memory roots before comparison. Assert heading order, exact tool names,
exact product sections, no duplicate policy section, and no unresolved known template variable.
Intentional text changes require a reviewed snapshot update; whitespace-only drift is not ignored.

## Agent runtime factories

Import the following from `negotium/agent-helpers`:

```ts
createAskUserRuntime(host: AskUserRuntimeHost): AskUserRuntime;
createArchiverRuntime(host: ArchiverHost): ArchiverRuntime;
createTopicLogMaintenance(host: TopicLogMaintenanceHost): TopicLogMaintenance;
createSelfConfigCore(
  host: SelfConfigHost,
  product?: Partial<SelfConfigProductConfig>,
): SelfConfigCore;
createSelfConfigRuntime(options: SelfConfigRuntimeOptions): SelfConfigRuntime;
createSubagentLifecycle<TContext extends SpawnSubagentToolContext>(
  host: SubagentLifecycleHost<TContext>,
): SubagentLifecycle<TContext>;
```

`createSelfConfigRuntime` is the supported combined adoption path: it constructs the core and MCP
tool definitions from one host and one product policy. `createSelfConfigCore` and
`createSelfConfigToolDefinitionsForCore` are exposed for hosts that compose their own MCP server,
but they use the same core instance and must not be configured independently.

Import `createSessionTargetCatalog` and its host/result types from `negotium/mcp-factories`.
The catalog accepts `listRows`, `isAgent`, and the current topic id/title. It owns manager/current
filtering, case-insensitive collision detection, qualified aliases, lookup, and validation errors.
Inbox paths, browser ports, legacy session configuration, and tell/ask delivery remain product
transport glue.

Every stateful factory owns isolated in-memory state. Create one long-lived instance per runtime
host; do not construct a new ask-user, archiver, self-config tool, or subagent lifecycle for each
callback. Host implementations own persistence and publication durability, while the factory owns
ordering, idempotency, lifecycle settlement, and policy limits.

`SubagentLifecycleHost.config.limits` optionally overrides `maxDepth`,
`maxLiveChildrenPerParent`, and `maxPreparedChildrenPerParent`. Values are captured when the
factory is created and must be positive integers; omitted values retain Negotium defaults.

## Extraction policy

Public factories are justified when Negotium owns a reusable state machine and the downstream code
can be reduced to a host implementation. Code that primarily selects product ports, environment
variables, catalogs, routes, or barrels remains downstream-owned.

The candidate decisions below are final for 0.1.39. No downstream migration may use raw internal
imports.

| Candidate | Decision | Target |
| --- | --- | --- |
| `prompts/builders.ts` | Extracted as `createPromptBuilders` | 0.1.39 |
| `agents/mcp-tools/ask-user.ts` | Extracted as `createAskUserRuntime` | 0.1.39 |
| `agents/topic-cleanup.ts` | Extracted as `createTopicLogMaintenance` | 0.1.39 |
| `agents/archiver.ts` | Extracted as `createArchiverRuntime`; product scheduling stays outside | 0.1.39 |
| `agents/self-config-core.ts` + `agents/mcp-tools/self-config.ts` | Extracted together through `createSelfConfigRuntime` | 0.1.39 |
| `mcp/session-comm/topics.ts` | Target catalog extracted as `createSessionTargetCatalog`; delivery stays outside | 0.1.39 |
| `agents/mcp-tools/spawn-subagent.ts` | Extracted as `createSubagentLifecycle` | 0.1.39 |
| `agents/idle-archiver.ts` | Keep downstream policy glue | Keep |
| `platform/mcp-config.ts` | Keep downstream catalog and transport composition | Keep |
| `platform/config.ts` | Keep downstream paths, ports, environment, and secrets | Keep |
| `agents/index.ts` | Keep downstream provider wiring around `runHostedAgent` | Keep |

Each extracted factory has package-level type smoke and host-isolation tests. Otium migration is
complete only when its local module contains host wiring rather than a second lifecycle
implementation.

### Host boundaries

The interfaces below define ownership, not final method names. Implementation PRs must publish the
exact structural types and may split a large repository into nested interfaces.

**Ask user**

- storage: topic membership, message lookup/append, and atomic
  prepare/claim/cancel/quarantine operations for durable ask gates;
- messaging: publish a new message and publish an ask-card update;
- config: resolve effective agent/model metadata for the visible card;
- runtime: process-lease ownership, IDs, and clock.

The factory owns input normalization, idempotency hashing, pending promise settlement, answer
validation, cancellation, and foreign-owner reconciliation. WebSocket classes and database handles
must not appear in its public API.

**Topic cleanup**

- storage: read raw/active conversation manifests, resolve their paths, and atomically replace or
  unlink them;
- runtime: enumerate agent kinds and clean provider rollouts for `(cwd, sessionIds)`;
- diagnostics: structured warning logger.

The factory owns session-ID collection, cleanup-before-unlink ordering, retry-safe failure results,
and bounded rotation. A downstream host must not reimplement those invariants.

**Archiver**

- storage: shared Wiki directory, topic brief read/write, summary discovery, and visible message
  append;
- messaging: publish background-session and final-message updates;
- runtime: load the archiver definition and run a silent agent turn with a restricted MCP set;
- config: workspace root, completion retention, default agent/model, IDs, and clock.

The factory owns the background session state machine and event reduction. Idle thresholds,
environment variable names, and the decision to schedule an archive remain downstream policy.

**Self configuration**

- storage: read/write effective topic config and one-shot self schedules;
- authorization: validate agent/model availability;
- runtime: switch provider session, create/fork derived topics, resolve workspace paths, and render
  topic links;
- messaging: publish config and derived-topic updates.

Core operations and `createSelfConfigToolDefinitions` ship together. A host cannot adopt one without
the other because tool schemas, limits, and result semantics are one compatibility surface.

**Session target catalog**

- storage: `listRows()` returns caller-visible topic rows;
- context: current topic ID/title and an `isAgent` type guard.

The factory owns collision-safe aliases, current/manager filtering, target validation, and DTO
mapping. Legacy configuration, inbox paths, browser-port lookup, tell/ask delivery, peer routing,
and WebSocket publication remain outside this read model.

**Subagents**

- storage: create/read/update/delete child topics, ancestry, report mode, memory origin, and durable
  card/watch state;
- messaging: publish cards, status changes, completion text, and parent injections;
- runtime: start/abort child turns, inspect active leases, authorize routing, and settle parent
  callbacks;
- config: depth and child-count limits, model catalog, workspace paths, IDs, and clock.

The factory owns lifecycle serialization, depth enforcement, watch settlement, stale-card recovery,
and MCP tool definitions. The public host is grouped into `storage`, `topic`, `task`,
`sessionCommunication`, `runtime`, and `config` boundaries; it is not a flat mirror of internal
imports.

### Explicit downstream keeps

`idle-archiver` already delegates the reusable archive operation and should retain only Otium
environment policy and busy-state wiring. `platform/mcp-config`, `platform/config`, and
`agents/index` select product catalogs, ports, paths, environment variables, and provider hosts.
Their existing use of Negotium helpers is the intended boundary. Extract individual pure helpers
only when a second independent consumer appears; do not create whole-file factories for these
modules.
