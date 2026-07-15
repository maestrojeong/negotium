# Negotium architecture

This document defines the runtime model and invariants maintainers must preserve. Installation and
CLI usage live in the root [README](../README.md); channel-specific behavior lives in
[Adapters](./ADAPTERS.md).

## Purpose

Negotium turns one computer into one durable agent node. A node owns topics, provider sessions,
queues, tools, workspaces, and local state. Terminal, Telegram, Otium, and custom hosts are adapters
around the same runtime rather than separate execution engines.

The repository is split into four layers:

```text
hosts and adapters
        │ input API                 ▲ RuntimeBus events
        ▼                           │
@negotium/node ─ lifecycle, control API, modules, durable workers
        │
@negotium/core ─ topics, turns, providers, queues, storage, memory
        │
@negotium/mcp + built-in MCP servers + @negotium/mcp-host
```

Core never imports a channel SDK, a workspace control plane, or a product database. Adapters own
external identity and rendering. Optional capabilities enter through explicit node modules.

## Core concepts

| Concept | Meaning | Primary source |
| --- | --- | --- |
| **Topic** | A conversation and unit of work with an agent, model, effort, and workspace | `packages/core/src/topics/`, `storage/api-topics.ts` |
| **Turn** | One prompt executed by one provider inside a topic | `runtime/turn-runner.ts` |
| **RuntimeBus** | The only runtime-to-host event boundary | `bus.ts` |
| **Inbox** | Durable ingress for cross-topic and external injections | `runtime/inbox.ts` |
| **MCP catalog** | Tool servers mounted for a turn | `platform/mcp-config.ts` |
| **Node module** | An optional capability with explicit start and stop hooks | `platform/modules.ts` |

## Invariants

These rules are more important than any individual implementation:

1. A topic has at most one active turn.
2. New human input may supersede the active turn; background, Cron, and cross-topic injections wait.
3. Durable queue delivery is at-least-once and deduplicated by request ID.
4. A terminal outcome is emitted once per turn, after any final message event.
5. Provider-native sessions remain scoped to one topic and one provider.
6. Hosts own channel identities and presentation; core owns execution and local runtime state.
7. Disabled modules add no timer, listener, schema migration, or hot-path dispatch.
8. Shutdown closes ingress before aborting turns and reaping child processes.

## Turn lifecycle

```text
host persists input
  → startAiTurn(topic, prompt)
  → decide admission or supersession
  → resolve topic configuration
  → build the MCP catalog and signed turn context
  → run the selected provider
  → persist normalized events and publish RuntimeBus events
  → release the topic lock
  → drain one deferred injection
```

Configuration resolves in this order:

```text
per-request override → persisted topic override → topic default → provider registry default
```

Every exit path, including setup failure, abort, provider error, and success, must converge on the
same lock release and queue-drain logic. Session-expiry recovery may rebuild a rollout and retry once;
it must not create an unbounded retry loop.

## State ownership

The default state root is `~/.negotium`:

```text
data/        SQLite state, vault data, and MCP manifest
run/         Ephemeral leases, inbox claims, port files, and progress state
workspace/   Topic workspaces, shared wiki, skills, summaries, and browser profiles
logs/        Rotated structured activity logs
```

SQLite uses WAL mode and a busy timeout. One long-lived node owns a state directory; multiple
Terminal clients and channel adapters coordinate through that node and the shared database.

| State | Owner |
| --- | --- |
| Topics, messages, topic configuration | Core storage |
| Provider session IDs and neutral conversation log | Core runtime |
| Tasks, wiki, skills, and vault | Built-in runtime services |
| Channel chat, thread, or room IDs | The corresponding adapter |
| Workspace membership and remote node placement | The external control plane |
| Terminal selection, scroll, and composer state | One Terminal client process |

Topic deletion archives the conversation before deleting live rows. A failed archive leaves the
source intact. Secrets are encrypted at rest and bound to the local state root; normal tool output
must never reveal vault plaintext or authentication tokens.

## Collaboration

Cross-topic operations converge on the inbox and the same turn admission rules:

- `tell_session` appends fire-and-forget work to the target topic.
- `ask_session` forks the target session for a read-only turn and injects the answer back into the
  caller without mutating the target session.
- `spawn_subagent` creates a child topic, runs it independently, and reports completion to the parent.

The file-backed inbox exists because session communication tools may run in separate MCP processes.
Append plus atomic claim/rename provides a small, crash-tolerant at-least-once queue. Request IDs make
replay safe.

## Provider boundary

Claude, Codex, and Maestro implement one registry and event contract. Provider-specific code may own
authentication, model validation, effort mapping, rollout encoding, and native session cleanup. It
must emit provider-neutral events for messages, tools, files, status, usage, and terminal outcomes.

Switching agent or model invalidates incompatible native session state while preserving the visible
conversation. Rebuilding one provider from the neutral log must not mutate another provider's native
rollout.

## MCP layers and security

Negotium exposes tools through three layers:

1. `@negotium/mcp` serves runtime and node tools over an authenticated HTTP endpoint.
2. Built-in short-lived stdio servers provide tasks, wiki, vault, health, and session communication.
3. `@negotium/mcp-host` manages user-assigned long-lived MCP processes and ports.

Each turn receives a signed context containing the user, topic, and query scope. Runtime tools trust
that context, not caller-supplied identity fields. Topic access, file paths, and secrets must be
validated at the boundary that owns them.

## Hosts, adapters, and modules

A host normally performs three operations:

```ts
appendApiMessage({ /* inbound user message */ });
startAiTurn({ topic, userId, prompt, allowAutoContinue: true });
runtimeBus().subscribe(render);
```

Adapters translate external identities and media into this contract and render bus events back to
their channel. They persist their own mapping state and declare transcript capabilities. See
[Adapters](./ADAPTERS.md) for private/shared topic access and projection rules.

Modules are started explicitly by the node. Startup failures clean up already-started modules in
reverse order. Duplicate capability IDs or request-handler names are rejected. `stop()` must be safe
to call more than once.

## Recovery and shutdown

Startup recovery must converge abandoned queue claims, running turn requests, peer requests, and
Cron runs to a state that can be retried or reported. Health must distinguish process liveness from
worker readiness.

Shutdown order is:

1. Stop accepting new control and channel input.
2. Stop schedulers and durable workers from claiming more work.
3. Abort active turns.
4. Reap provider and MCP child processes.
5. Stop adapters and modules in reverse startup order.
6. Close servers and storage handles.

## Suggested reading order

1. `packages/core/src/bus.ts`
2. `packages/core/src/topics/create.ts`
3. `packages/core/src/storage/api-topics.ts`
4. `packages/core/src/runtime/turn-runner.ts`
5. `packages/core/src/query/active-rooms.ts`
6. `packages/core/src/runtime/inbox.ts`
7. One provider in `packages/core/src/agents/`
8. `packages/mcp/src/node-tools.ts`
9. `packages/node/src/index.ts`
