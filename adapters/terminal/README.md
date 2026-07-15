# @negotium/adapter-terminal

A zero-UI-dependency terminal client for Negotium. It connects to one long-lived
local node and renders topics, messages, tools, shared tasks, and blocking
`ask_user_question` cards in one alternate-screen TUI.

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
negotium terminal --topic=chat --agent=maestro --user=local
```

Set `DEEPSEEK_API_KEY` in the working directory's ignored `.env` to authenticate
Maestro Agent SDK. `GEMINI_API_KEY` is optional for image QA.

The first `negotium terminal` automatically starts one authenticated loopback
node for the current `NEGOTIUM_STATE_DIR`. Later Terminal processes connect to
that same node:

```bash
negotium start terminal  # shell 1
negotium start terminal  # shell 2
```

Closing one TUI does not stop another. A custom embedding host can still inject
a `NegotiumClient` without changing the TUI. Node lifecycle commands and recovery
paths are explicit:

```bash
negotium status                         # inspect the shared node
negotium stop                           # stop it and its active turns
negotium serve --port=7777              # run it in the foreground
negotium terminal --embedded            # legacy/recovery: node inside this TUI
negotium terminal --connect=http://127.0.0.1:7777
```

`--port=N` selects the port only when Terminal must auto-start a node; zero (the
default) selects an available loopback port. `--connect` uses
`NEGOTIUM_CONTROL_TOKEN` when it is set, otherwise the local state token.

## Layout

```text
  › You
    investigate the failure

  ✦ Otium
    I found the cause…
    ✓ Bash(test)

  › Type a message or /command…
  Ctrl-O topics
  research · codex · model                                  ⠋ Working
```

Markdown, fenced code, tool calls, shared tasks, and approval choices render
inline in chronological order. Tool activity stays compact: one inline line
per tool, bounded `Edit`/`Write` change previews, and a clear working
indicator. Topics and transcript use temporary overlays.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | send text, or accept the selected ask choice |
| `Alt-Enter` | insert a newline |
| `Ctrl-P` / `Ctrl-N` | previous / next topic |
| `Up` / `Down` | edit multiline input, history, suggestions, or ask choices |
| `PageUp` / `PageDown` | scroll conversation |
| Mouse wheel / trackpad | scroll conversation history |
| `Ctrl-E` | load one older 50-message page |
| Mouse drag | select screen text and copy it on release |
| `Ctrl-O` | toggle topic overlay |
| `Ctrl-T` | toggle the plain transcript overlay |
| `Ctrl-Y` | copy the latest agent response |
| `Ctrl-L` | redraw |
| `Esc` | close overlay or clear composer |
| `Ctrl-C` | abort/cancel; press twice on an idle screen to quit this TUI |

Commands: `/compact` (summarize and shrink provider context), `/status` (separate latest context
occupancy from aggregate turn usage), `/new` (reset the current context), `/topics` (open the
topic picker), `/del [name]`,
`/copy [all]`, `/abort`, `/help`, `/quit`.

A reset keeps the visible transcript, cancels active and queued work accepted before the reset,
and lets later requests start with a fresh provider context. This includes the private `General`
topic. In the `Ctrl-O` topic overlay, press `N`, type only the new topic name, and press `Enter`;
the new topic opens immediately. After deleting a topic, Terminal returns to the topic overlay.

Compaction also preserves the visible transcript, but replaces provider-native and provider-neutral
context with a standalone summary so the next turn can continue with a smaller context. Reopening a
topic initially loads the latest three pages (150 messages). Wheel and PageUp stop at the loaded
boundary; `Ctrl-E` explicitly loads one older 50-message page. The boundary becomes the fixed start
of the conversation after the full persisted history is available.

The picker reads every `visibility: visible` topic, including both private and
shared topics. Internal Otium execution mirrors remain hidden and do not appear
in Terminal.

## Architecture

- `src/client.ts`: the host boundary. `RemoteNegotiumClient` uses authenticated
  REST plus a cursor-based SSE event stream; `EmbeddedNegotiumClient` is the
  explicit fallback.
- `src/state.ts`: deterministic reducer for runtime bus events.
- `src/render.ts`: responsive ANSI rendering and Unicode-aware wrapping.
- `src/screen-renderer.ts`: cached line diffing; it never clears and repaints the whole display.
- `src/app.ts`: raw terminal input, commands, topic/message loading, lifecycle.

The adapter never calls provider SDKs directly. Ask, task, subagent, wiki, and
Playwright behavior stays inside Negotium, so switching Claude/Codex/Maestro
does not fork terminal-specific state.

## Development

```bash
bun run --filter @negotium/adapter-terminal check
bun test adapters/terminal
```
