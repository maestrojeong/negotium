<div align="center">
  <h1>Negotium</h1>
  <p><strong>Turn one computer into a durable, multi-agent node.</strong></p>
  <p>
    Claude Code · Codex · Maestro · MCP · local-first state · scheduled turns
  </p>
  <p>
    <a href="./LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-4c1.svg"></a>
    <img alt="Bun 1.2+" src="https://img.shields.io/badge/runtime-Bun_1.2%2B-000000?logo=bun&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=white">
    <img alt="Status: early stage" src="https://img.shields.io/badge/status-early_stage-f59e0b">
  </p>
</div>

> *Negotium* is Latin for “work” — literally *nec otium*, the absence of leisure.
> Your machines do the negotium so you can keep the otium.

Negotium is a host-agnostic runtime for long-lived AI agents. A node owns its topics,
provider sessions, MCP tools, workspace, memory, queues, and encrypted secrets. A terminal,
Telegram bot, or workspace app is only a thin host around that same runtime.

The project is source-first and early-stage: the packages are not published to npm yet, and
public APIs may still change.

## Why Negotium?

- **Three agent backends, one runtime** — run Claude Code, Codex, or Maestro per topic and
  preserve provider-native sessions across turns.
- **Durable collaboration** — agents can `tell_session`, `ask_session`, and delegate through
  `spawn_subagent`; busy rooms queue work instead of dropping it.
- **Local-first state** — SQLite, JSONL conversations, workspaces, wiki memory, and an
  encrypted vault live under one node directory.
- **MCP-native tools** — tasks, wiki/skills, vault, browser automation, background shell,
  health, files, and node controls are mounted for each turn.
- **Composable modules** — hosts explicitly opt into features such as persistent Cron jobs;
  disabled modules install no timer, listener, or schema.
- **One adapter boundary** — hosts send messages through the core API and render everything
  from `runtimeBus()`.

## Quick start

### 1. Install

Requirements:

- [Bun](https://bun.sh/) 1.2 or newer
- Node.js 20+ when using Codex's stdio MCP tools
- macOS or Linux; the runtime currently expects POSIX process controls
- credentials for at least one supported agent

```bash
git clone git@github.com:maestrojeong/Negotium.git
cd Negotium
bun install
```

### 2. Authenticate an agent

Choose at least one:

| Agent | Authentication |
|---|---|
| Claude | Run `claude` and finish login, or set `ANTHROPIC_API_KEY` |
| Codex | Run `codex login` |
| Maestro | Set `DEEPSEEK_API_KEY`; `GEMINI_API_KEY` is optional for image QA |

For environment-based credentials and node settings:

```bash
cp .env.example .env
```

Bun loads the repository's `.env` automatically.

### 3. Start chatting

```bash
bun run apps/cli/src/main.ts init
bun run apps/cli/src/main.ts chat work --agent=codex
```

Pick `claude`, `codex`, or `maestro` according to the auth check printed by `init`.

Until the CLI is published, the rest of this document uses `negotium` as shorthand for:

```bash
bun run apps/cli/src/main.ts
```

## CLI

```text
negotium init
negotium chat [topic] [--agent=claude|codex|maestro]
negotium serve
negotium topics

negotium mcp list|add|remove|enable|disable
negotium vault list|set|get|del
negotium cron list|create|inspect|run|pause|resume|reset|delete
```

Inside terminal chat:

```text
/switch <topic>    create or enter another topic
/abort             stop the current turn
/quit              close the terminal host
```

### Run a headless node

```bash
negotium serve
```

The node binds to `127.0.0.1:7777` by default and serves the runtime MCP endpoint, durable
inbox worker, configured MCP processes, and enabled modules. Keep it alive with a process
supervisor such as `launchd`, systemd, or pm2.

One state directory must have **one long-lived runtime process**. A Telegram host already is
the node, so do not run `negotium serve` against the same state directory at the same time.

## Scheduled agent turns

Cron is an optional in-process module enabled by the reference CLI host. Create the target
topic first, create a schedule, and keep a node host running:

```bash
negotium chat operations --agent=codex

negotium cron create \
  operations \
  weekday-review \
  '0 9 * * 1-5' \
  'Review open work and write a concise status report.' \
  --timezone=America/Los_Angeles

negotium cron list
negotium serve
```

Each job has durable run history and its own provider session. The scheduler uses one timer
and an indexed `next_run_at`; it does not create one process per job. Scheduled work waits
behind an active human turn and never preempts it.

Set `NEGOTIUM_CRON=0` to keep the module completely unloaded.

## Agent collaboration

Every topic is a room with one selected agent and at most one active turn. The runtime gives
agents a shared collaboration surface:

| Tool | Behavior |
|---|---|
| `send_message` / `tell_session` | Queue fire-and-forget work for another topic |
| `ask_session` | Fork another topic's session read-only and route the answer back |
| `spawn_subagent` | Create a child room with its own session and report completion to the parent |
| `task_*` | Maintain shared durable tasks |
| `wiki_query` / `skill_*` | Read and extend long-term memory and skills |
| `vault_*` | Use encrypted credentials without exposing plaintext to normal tool paths |

User turns take priority: a new user message supersedes a running turn, while agent-to-agent
injections wait in the target room's queue.

## Architecture

```text
                         one machine = one node

  CLI / Telegram / Otium host / custom adapter
              │ input API            ▲ RuntimeBus events
              ▼                      │
  ┌─────────────────────────────────────────────────────────┐
  │ @negotium/core                                         │
  │ topics · turns · providers · queues · storage · memory │
  │                                                        │
  │ Claude Code ─┐                                         │
  │ Codex ───────┼─ provider-neutral event stream          │
  │ Maestro ─────┘                                         │
  └──────────────┬──────────────────────┬───────────────────┘
                 │                      │
       @negotium/mcp          optional node modules
       runtime/node tools     @negotium/module-cron · …
                 │
       @negotium/mcp-host
       managed MCP processes

  ~/.negotium/{data,run,workspace}
```

The core invariants are intentionally small:

1. At most one active turn per topic.
2. Human input outranks background injection.
3. Queue delivery is at-least-once and deduplicated by request ID.
4. Hosts own channel identity and rendering; core owns execution and local state.
5. Optional features enter through explicit node modules, not product-specific branches.

For the detailed design, read [Architecture (한국어)](./docs/ARCHITECTURE.ko.md).

## Embed the runtime

A channel adapter persists inbound messages, starts a turn, and subscribes to outbound events:

```ts
import {
  appendApiMessage,
  registerTopic,
  runtimeBus,
  startAiTurn,
} from "@negotium/core";

const topic = registerTopic({
  title: "support",
  userId: "local",
  agent: "codex",
});

const unsubscribe = runtimeBus().subscribe((event) => {
  // Render message, status, tool, file, and topic events in your channel.
  console.log(event);
});

appendApiMessage({
  id: crypto.randomUUID(),
  topicId: topic.id,
  authorId: "local",
  text: "Inspect this repository.",
  createdAt: new Date().toISOString(),
});

startAiTurn({
  topic,
  userId: "local",
  prompt: "Inspect this repository.",
  allowAutoContinue: true,
});

// Call when the host shuts down.
unsubscribe();
```

The reference implementation is
[`apps/cli/src/commands/chat.ts`](./apps/cli/src/commands/chat.ts). The production Telegram
adapter lives in [maestrojeong/telegram-adapter](https://github.com/maestrojeong/telegram-adapter).

### Compose optional modules

```ts
import { createCronModule } from "@negotium/module-cron";
import { startNode } from "negotium-cli/node";

const node = startNode({
  modules: [createCronModule()],
});

// Later:
await node.stop();
```

Modules advertise stable capability IDs such as `scheduler.cron.v1`. A disabled module is not
imported and cannot migrate a table or install background work.

## Node state

The default state root is `~/.negotium`; override it with `NEGOTIUM_STATE_DIR`.

```text
~/.negotium/
├── data/       SQLite databases, MCP manifest, generated node secrets
├── run/        transient inbox queues, progress state, MCP port files
└── workspace/  topic workspaces, shared wiki, skills, browser profiles
```

Important environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `NEGOTIUM_STATE_DIR` | `~/.negotium` | Node state root |
| `NEGOTIUM_PORT` | `7777` | Loopback runtime/MCP port |
| `FALLBACK_AGENT` | `maestro` | Agent for newly created topics |
| `FALLBACK_MODEL` | provider default | Optional node-wide model override |
| `NEGOTIUM_CRON` | `1` | Set to `0` to omit the Cron module |
| `NEGOTIUM_CRON_POLL_INTERVAL_MS` | `1000` | Scheduler polling interval |
| `NEGOTIUM_CRON_RUN_TIMEOUT_MS` | `600000` | Maximum scheduled-turn duration |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `fatal` |

The vault stores row-bound authenticated ciphertext in `data/vault.db`; its node master key is
created with mode `0600`. Do not commit `.env` or copy a live state directory between running
nodes.

## Packages

| Package | Responsibility |
|---|---|
| [`@negotium/core`](./packages/core) | Providers, turns, topics, storage, queues, memory, tools, host boundary |
| [`@negotium/mcp`](./packages/mcp) | Authenticated HTTP MCP endpoint and node/runtime tools |
| [`@negotium/mcp-host`](./packages/mcp-host) | Long-lived MCP process, port, health, and idle-eviction manager |
| [`@negotium/module-cron`](./packages/module-cron) | Persistent schedules, run journal, scheduler, and Cron MCP tools |
| [`negotium-cli`](./apps/cli) | Reference terminal and headless node host |

Planned: `@negotium/module-otium-peer`, which will connect invited worker computers to an
Otium workspace without putting workspace authority into the core runtime.

## Development

```bash
bun test          # all core, MCP, host, and Cron tests
bun run build     # TypeScript checks for every workspace package
bun run lint      # Biome checks
```

Internal package imports use `#` subpath aliases. Cross-package code goes through each
package's public barrel.

## Design documents

- [Architecture and invariants (한국어)](./docs/ARCHITECTURE.ko.md)
- [Clawgram · Negotium · Otium product boundaries (한국어)](./docs/PRODUCT-TOPOLOGY.ko.md)
- [Otium worker-node coupling contract](./docs/OTIUM-COUPLING.md)

## License

[Apache License 2.0](./LICENSE)
