# negotium

> *negotium* (Latin) — "work"; literally *nec-otium*, "the absence of leisure".
> Your machines do the negotium, so you keep the otium.

**Turn any computer into an agent node.** negotium is an open-source multi-agent runtime that
treats each machine as one object: a node that owns a set of MCP servers, runs coding agents
(**Claude / Codex / Maestro**) against them, and persists everything under `~/.negotium/`.

Topics (rooms) live in the node. Agents in different topics talk to each other
(`tell_session` / `ask_session`), delegate work to child rooms (`spawn_subagent`), remember
across sessions (wiki/skills), and keep secrets in an encrypted vault. Channels — a terminal,
a Telegram bot, an otium workspace — are thin adapters over one host boundary, so building
"clawgram" on top is an afternoon, not a platform.

## Quick start

```bash
git clone https://github.com/maestrojeong/negotium && cd negotium
bun install

bun run apps/cli/src/main.ts init     # bootstrap ~/.negotium + check agent auth
bun run apps/cli/src/main.ts chat     # talk to an agent from your terminal
```

`init` shows which agents are ready. Claude authenticates via Claude CLI OAuth, Codex via its
own CLI auth, Maestro needs `DEEPSEEK_API_KEY` (+ optional `GEMINI_API_KEY` for its image-QA
tool). Copy `.env.example` → `.env` for keys and node settings — bun loads it automatically.

### CLI

```bash
negotium init                  # bootstrap ~/.negotium, report agent auth status
negotium chat [topic]          # interactive chat; --agent=claude|codex|maestro
                               #   /switch <topic>  /abort  /quit
negotium serve                 # headless node: MCP endpoint + queue workers
negotium topics                # list topics on this node
negotium mcp list|add|remove|enable|disable    # this node's MCP manifest
negotium vault list|set|get|del                # encrypted secret store
negotium cron list                             # persistent scheduled turns
negotium cron create chat standup '0 9 * * 1-5' 'Summarize current work' --timezone=America/Los_Angeles
negotium cron run|pause|resume|reset|delete <name|id>
```

(Until it ships to npm, `negotium` = `bun run apps/cli/src/main.ts`.)

### Telegram bot

The Telegram channel lives in its own repo, consuming negotium as a library:
[telegram-adapter](https://github.com/maestrojeong/telegram-adapter) — chat + forum-topic
modes, `/new` `/topics` `/agent` `/abort`, spawn_subagent children materialize as real
forum topics. The bot process **is** the node — don't run a second runtime against the
same `~/.negotium`.

## Running a node

One machine = one node = **one long-lived runtime process** (state is SQLite-WAL under one
dotdir). The host process embeds the runtime: run `negotium serve` headless, or run a channel
host (like the Telegram bot) which doubles as the node. Keep it alive with pm2/launchd:

```bash
pm2 start "bun run example/bot.ts" --name negotium-node --cwd ~/telegram-adapter
```

| Env | Default | Meaning |
|---|---|---|
| `NEGOTIUM_STATE_DIR` | `~/.negotium` | all node state (workspace/data/run/logs) |
| `NEGOTIUM_PORT` | `7777` | the node's open port (runtime MCP endpoint) |
| `FALLBACK_AGENT` | `maestro` | default agent for new topics |
| `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` | — | maestro inference / image-QA |
| `NEGOTIUM_CRON` | `1` | set to `0` to skip importing and starting the Cron module |
| `NEGOTIUM_CRON_POLL_INTERVAL_MS` | `1000` | Cron due-queue polling interval |
| `NEGOTIUM_CRON_RUN_TIMEOUT_MS` | `600000` | maximum time for one scheduled turn |

Cron runs in the existing node process. It stores one indexed `next_run_at` per job and gives
each job its own provider session; it does not create a pm2 process per schedule. A node host
must remain alive for jobs to execute.

## What a topic can do

Every topic (room) runs turns against its agent with the **negotium MCP** mounted:

- `register_topic` / `list_topics` / `send_message` / `abort_topic` / `delete_topic` — node
  tools; `send_message` is fire-and-forget (queued durably if the target is mid-turn,
  delivered as a turn when it frees up)
- `tell_session` / `ask_session` — inter-topic messaging; asks fork the target session
  read-only and route the answer back automatically (depth-capped)
- `spawn_subagent` — delegate to a child room (own fresh session, live status card in the
  parent, result auto-injected back; recursion-guarded, max 5 live children)
- `task_*`, `skill_query/save`, `wiki_query` — shared task system + long-term memory
- vault, system/agent health, background bash, browser (mcp-patchright), OCR

Deleting a topic archives its conversation into the wiki first (`delete_topic` refuses to
lose history unless `force`).

## Architecture

```
┌─────────────────────────── your machine = one node ────────────────────────────┐
│  host (CLI / Telegram / otium / …)                                              │
│    in:  message → startAiTurn(topic, prompt)                                    │
│    out: runtimeBus().subscribe(render)          ← the ENTIRE adapter contract   │
│      ▼                                                                          │
│  @negotium/core — turn runner (abort-on-new-message, session-expiry retry),     │
│    AgentProvider: claude │ codex │ maestro, topics/messages/tasks/wiki/vault,   │
│    durable inbox queues (tell/ask/abort)                                        │
│      ├── serves ─► @negotium/mcp    (HTTP MCP endpoint, HMAC per-turn tokens)   │
│      └── spawns ─► @negotium/mcp-host (ports · health · idle-eviction)         │
│  state: ~/.negotium/{workspace, data, run, logs}                                │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| Package | What it is |
|---------|------------|
| [`@negotium/core`](./packages/core) | The runtime. Everything above; 300+ ported tests |
| [`@negotium/mcp`](./packages/mcp) | The node's MCP endpoint + node tools |
| [`@negotium/mcp-host`](./packages/mcp-host) | Declarative `McpServerSpec` process/port manager |
| [`@negotium/module-cron`](./packages/module-cron) | Optional in-process scheduler + Cron MCP tools |
| [`@negotium/adapter-telegram`](https://github.com/maestrojeong/telegram-adapter) | Telegram channel as a library (separate repo — consumes negotium as npm deps) |
| `@negotium/module-otium-peer` | Planned Otium invited-worker/relay module; wire contract is documented now |
| [`negotium-cli`](./apps/cli) | Reference host |

## Writing your own channel adapter

An adapter is two functions against the host boundary:

```ts
import { appendApiMessage, registerTopic, runtimeBus, startAiTurn } from "@negotium/core";

// in: whatever your channel receives
appendApiMessage({ id, topicId: topic.id, authorId: "local", text, createdAt });
startAiTurn({ topic, userId: "local", prompt: text, allowAutoContinue: true });

// out: whatever your channel renders
runtimeBus().subscribe((ev) => { /* "message" | "ai-status" | "topic-created" | … */ });
```

See [`apps/cli/src/commands/chat.ts`](./apps/cli/src/commands/chat.ts) (60 lines) and
[telegram-adapter](https://github.com/maestrojeong/telegram-adapter) for the production version.

## Composing optional modules

Hosts explicitly choose their modules. A disabled module is not imported, does not migrate a
table, and installs no timer or listener.

```ts
import { startNode } from "negotium-cli/node";
import { createCronModule } from "@negotium/module-cron";

const node = startNode({ modules: [createCronModule()] });
```

Modules publish stable capability IDs such as `scheduler.cron.v1`. The future Otium peer module
uses the same boundary to advertise an invited computer's abilities without forking the runtime.
See [`docs/PRODUCT-TOPOLOGY.ko.md`](./docs/PRODUCT-TOPOLOGY.ko.md).

## Development

```bash
bun test          # full suite (root preload isolates state into a temp dir)
bun run lint      # biome
bun run build     # tsc --noEmit per package
```

Internal imports use `#`-subpath aliases (package.json `imports`); cross-package imports go
through each package's barrel only.

## License

[Apache-2.0](./LICENSE)
