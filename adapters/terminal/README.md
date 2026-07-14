# @negotium/adapter-terminal

A zero-UI-dependency terminal host for Negotium. It embeds one Negotium node,
subscribes to the runtime bus, and renders topics, messages, tools, shared tasks,
and blocking `ask_user_question` cards in one alternate-screen TUI.

It is a normal workspace/npm package and depends on the same `@negotium/node`
host as the Telegram and Otium adapters. It does not require another checkout
or a linked local package.

## Run

```bash
npm install --global @negotium/cli
negotium terminal
```

Options:

```bash
negotium terminal --topic=chat --agent=maestro --user=local --port=0
```

Set `DEEPSEEK_API_KEY` in the working directory's ignored `.env` to authenticate
Maestro Agent SDK. `GEMINI_API_KEY` is optional for image QA.

`--port=0` binds an ephemeral loopback port and is the default. For a terminal
and remote channels on the same runtime, use one combined process:

```bash
negotium start terminal telegram otium
```

In that mode the TUI attaches with `startNode: false`; the combined host owns
the single node. A future remote client can implement the `NegotiumClient`
interface without changing the TUI.

## Layout

```text
┌ topics ─────────────┬ conversation ────────────────────┬ activity ────────┐
│ ● research          │ you › investigate the failure    │ RUNNING           │
│   coding            │                                  │ Bash(test)        │
│   general           │ maestro › I found the cause…     │                   │
│                     │                                  │ Tasks (1/3)       │
│                     │                                  │ → reproduce       │
├─────────────────────┴──────────────────────────────────┴───────────────────┤
│ message…                                                        send: Enter │
└─────────────────────────────────────────────────────────────────────────────┘
```

Below 100 columns the side panes collapse and the conversation gets the full
width. Topic switching still works through keys or slash commands.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | send text, or accept the selected ask choice |
| `Ctrl-P` / `Ctrl-N` | previous / next topic |
| `Up` / `Down` | move through an active ask card |
| `PageUp` / `PageDown` | scroll conversation |
| `Ctrl-X` | abort the active turn |
| `Ctrl-O` | toggle topic overlay |
| `Ctrl-L` | redraw |
| `Esc` | close overlay or clear composer |
| `Ctrl-C` | quit and cleanly stop child processes |

Commands: `/new <name> [agent]`, `/topic <name>`, `/abort`, `/topics`,
`/help`, `/quit`.

The picker reads every `visibility: visible` topic, including both private and
shared topics. Internal Otium execution mirrors remain hidden and do not appear
in Terminal.

## Architecture

- `src/client.ts`: the host boundary. The current implementation embeds core;
  a REST/WebSocket client can replace it later.
- `src/state.ts`: deterministic reducer for runtime bus events.
- `src/render.ts`: responsive plain ANSI rendering and Unicode-aware wrapping.
- `src/app.ts`: raw terminal input, commands, topic/message loading, lifecycle.

The adapter never calls provider SDKs directly. Ask, task, subagent, wiki, and
Playwright behavior stays inside Negotium, so switching Claude/Codex/Maestro
does not fork terminal-specific state.

## Development

```bash
bun run --filter @negotium/adapter-terminal check
bun test adapters/terminal
```
