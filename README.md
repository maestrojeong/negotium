<div align="center">
  <h1>Negotium</h1>
  <p><strong>Turn one computer into a durable, multi-agent node.</strong></p>
  <p>
    Claude Code · Codex · Maestro · MCP · local-first state · scheduled turns
  </p>
  <p>
    <a href="./LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-4c1.svg"></a>
    <img alt="Bun 1.2.15+" src="https://img.shields.io/badge/runtime-Bun_1.2.15%2B-000000?logo=bun&logoColor=white">
    <img alt="TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=white">
    <img alt="Status: early stage" src="https://img.shields.io/badge/status-early_stage-f59e0b">
  </p>
</div>

> *Negotium* is Latin for “work” — literally *nec otium*, the absence of leisure.
> Your machines do the negotium so you can keep the otium.

Negotium is a host-agnostic runtime for long-lived AI agents. A node owns its topics,
provider sessions, MCP tools, workspace, memory, queues, and encrypted secrets. A terminal,
Telegram bot, or workspace app is only a thin host around that same runtime.

The project is source-first and early-stage. Its CLI, node host, adapter SDK, and first-party
adapters build as publishable npm packages, but no registry release has been made yet and public
APIs may still change.

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

- [Bun](https://bun.sh/) 1.2.15 or newer
- Node.js 20+ when using Codex's stdio MCP tools
- macOS or Linux; the runtime currently expects POSIX process controls
- credentials for at least one supported agent

```bash
git clone git@github.com:maestrojeong/negotium.git
cd negotium
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

After the first registry release, one global install provides the node and all three adapters:

```bash
npm install --global negotium
```

The canonical scoped package remains available as `@negotium/cli`; the unscoped package is a
functional convenience entrypoint rather than a name-only placeholder.

## CLI

```text
negotium init
negotium chat [topic] [--agent=claude|codex|maestro]
negotium serve
negotium status
negotium stop
negotium topics
negotium terminal
negotium telegram
negotium otium join|serve|bindings|share|private
negotium start <terminal|telegram|otium>

negotium mcp list|add|remove|enable|disable
negotium vault list|set|get|del
negotium cron list|create|inspect|logs|run|pause|resume|restart|kill|reset|delete
```

Inside terminal chat:

```text
/new                  reset the current topic's AI context, including personal General
/topics               open the topic picker
/del                  archive and delete the current topic
/copy [all]           copy the last answer or transcript
/abort                stop the current turn
/quit                 close the terminal host
```

Use `Ctrl-O` to choose topics. Press `N`, enter a topic name, and press `Enter` to create and open
it. Deleting a topic returns to the topic picker.

### Run the node and Terminal clients

```bash
negotium serve
```

The foreground node binds to `127.0.0.1:7777` by default and serves the runtime MCP endpoint,
durable inbox worker, configured MCP processes, enabled modules, and authenticated control API.
Keep it alive with a process supervisor such as `launchd`, systemd, or pm2.

`negotium terminal` needs no separate setup: it discovers or auto-starts one long-lived local
node for the current state directory, then connects over REST and a cursor-based SSE event stream.
Closing or crashing the TUI only disconnects that client; active agent turns and the node continue.

```bash
negotium status
negotium stop
negotium terminal --embedded   # explicit in-process recovery/development mode
```

Channel processes share durable SQLite state and do not need a common parent process. Terminal
clients may be opened more than once and share the long-lived node; Telegram and Otium currently
retain independent host processes and enforce one live process each for the same state directory:

```bash
negotium start terminal    # shell 1 (repeat in more shells if useful)
negotium start telegram    # shell 2
negotium start otium       # shell 3
```

The Terminal node publishes an ephemeral authenticated loopback control endpoint and holds a
state-directory singleton lease. Topics, messages, runtime events, pending turn requests, leases,
and input history are coordinated through the state database. The cron module also uses a
cross-process lease so only one process schedules jobs.

Resetting a topic preserves its visible message history, but cancels every active or queued turn
accepted before the reset. Requests accepted afterward start against a fresh provider context.

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

Every job belongs to a topic. Jobs in the same topic execute serially and share one Cron
conversation, so a later job can use conclusions and state produced by earlier scheduled runs.
That Cron conversation is separate from the topic's live human conversation. Provider-native
resume IDs are kept per agent under the shared topic context; when a different agent runs, the
runtime rebuilds its rollout from the provider-neutral Cron log. After every five successful
topic Cron runs, Negotium rotates the native provider sessions and carries the latest five
conversation turns into the replacement session. The cadence is topic-wide rather than
per-job, so several schedules cannot unexpectedly reset each other's context, and the shared
history stays useful without growing forever.

Jobs can also use a Python script whose stdout becomes the task prompt:

```bash
# Put daily-report.py in ~/.negotium/workspace/cron/jobs first.
negotium cron create operations daily-report '0 9 * * *' \
  --script=daily-report.py \
  --timezone=America/Los_Angeles
```

The scheduler uses one timer and an indexed `next_run_at`; it does not create one pm2 process
per job. Scheduled work waits behind an active human turn and never preempts it. If the node
process stops, execution stops too, but schedules and manual requests remain in SQLite. Run the
whole node under `launchd`, systemd, or pm2; after restart a missed schedule is coalesced into one
run instead of replaying an unbounded backlog.

Set `NEGOTIUM_CRON=0` to keep the module completely unloaded.

## Agent collaboration

Every topic is a room with one selected agent and at most one active turn. The runtime gives
agents a shared collaboration surface:

| Tool | Behavior |
|---|---|
| `tell_session` | Queue fire-and-forget work for another topic |
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

// startAiTurn returns immediately and streams in the background.
// Keep the subscription alive; call unsubscribe() during host shutdown.
```

The reference implementation is
[`apps/cli/src/commands/chat.ts`](./apps/cli/src/commands/chat.ts). First-party channel adapters
live together under [`adapters/`](./adapters), while each remains independently publishable.

### Compose optional modules

```ts
import { createCronModule } from "@negotium/module-cron";
import { startNode } from "@negotium/node";

const node = startNode({
  modules: [createCronModule()],
});

// Later:
await node.stop();
```

Modules advertise stable capability IDs such as `scheduler.cron.v1` and
`scheduler.cron.v2`. A disabled module is not
imported and cannot migrate a table or install background work.

## Node state

The default state root is `~/.negotium`; override it with `NEGOTIUM_STATE_DIR`.

```text
~/.negotium/
├── data/       SQLite databases, MCP manifest, generated node secrets
├── run/        transient inbox queues, progress state, MCP port files
├── workspace/  topic workspaces, shared wiki, skills, browser profiles, Cron scripts
├── logs/       rotating activity and token-usage JSONL
├── runtime-mcp-secret
└── vault-master-key
```

Important environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `NEGOTIUM_STATE_DIR` | `~/.negotium` | Node state root |
| `NEGOTIUM_LOG_DIR` | `<state>/logs` | Activity and token-usage logs |
| `NEGOTIUM_PORT` | `7777` | Loopback runtime/MCP port |
| `FALLBACK_AGENT` | `maestro` | Agent for newly created topics |
| `FALLBACK_MODEL` | provider default | Optional model override for the fallback session agent |
| `NEGOTIUM_CRON` | `1` | Set to `0` to omit the Cron module |
| `NEGOTIUM_CRON_POLL_INTERVAL_MS` | `1000` | Scheduler polling interval |
| `NEGOTIUM_CRON_RUN_TIMEOUT_MS` | `600000` | Maximum scheduled-turn duration |
| `NEGOTIUM_CRON_QUEUE_TIMEOUT_MS` | `300000` | Maximum wait behind a busy topic |
| `NEGOTIUM_CRON_SCRIPT_TIMEOUT_MS` | `600000` | Maximum Python prompt-script duration |
| `NEGOTIUM_CRON_JOBS_DIR` | `workspace/cron/jobs` | Python prompt-script directory |
| `NEGOTIUM_CRON_PYTHON` | `uv` or `python3` | Optional Python executable override |
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
| [`@negotium/node`](./packages/node) | Composable single-process node host used by every adapter |
| [`@negotium/adapter-sdk`](./packages/adapter-sdk) | Adapter API v2 lifecycle and transcript projection capability contract |
| [`@negotium/adapter-testkit`](./packages/adapter-testkit) | Runner-neutral contract assertions for adapter authors |
| [`@negotium/adapter-terminal`](./adapters/terminal) | Responsive local TUI channel |
| [`@negotium/adapter-telegram`](./adapters/telegram) | Telegram chat/forum channel and durable mapping store |
| [`@negotium/adapter-otium`](./adapters/otium) | Otium workspace worker and shared-topic binding |
| [`@negotium/cli`](./apps/cli) | Installable CLI and combined multi-adapter host |
| [`negotium`](./apps/negotium) | Functional unscoped entry package for the CLI |

## Development

```bash
bun test          # all core, MCP, host, adapter, and Cron tests
bun run build     # build publishable packages and check every workspace
bun run lint      # Biome formatter/linter checks
bun run check     # Biome checks followed by the full build
bun run release:dry-run  # inspect every npm package without publishing
```

New app and adapter packages use package-local `@/` source aliases. The build resolves those
aliases into portable JavaScript and declaration paths; cross-package code goes through each
package's public export.

## Design documents

- [Architecture and invariants (한국어)](./docs/ARCHITECTURE.ko.md)
- [npm release guide (한국어)](./docs/RELEASING.ko.md)
- [Adapter packaging, composition, and topic loading (한국어)](./docs/ADAPTERS.ko.md)
- [Clawgram · Negotium · Otium product boundaries (한국어)](./docs/PRODUCT-TOPOLOGY.ko.md)
- [Otium worker-node coupling contract](./docs/OTIUM-COUPLING.md)
- [Feature-by-feature review guide (한국어)](./docs/NEGOTIUM-FEATURE-REVIEW.ko.md)

## License

[Apache License 2.0](./LICENSE)
