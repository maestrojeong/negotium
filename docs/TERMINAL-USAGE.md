# Terminal usage

This document covers keyboard shortcuts, chat commands, and the live subagent graph
available in the Negotium Terminal client.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Open the topic picker | `Ctrl-O` |
| Create a topic from the picker | `Ctrl-N` |
| Delete the picked topic | `Ctrl-D` |
| Scroll loaded history | Mouse wheel or `PgUp` / `PgDn` |
| Load older history | `Ctrl-E` |
| Toggle shared tasks | `Ctrl-T` |
| Open the live subagent graph | `Ctrl-G` |
| Open the current topic's decision graph | `Ctrl-D` |
| Abort the current turn | `Ctrl-C` |

## Chat commands

```text
/new          reset the topic's AI context
/compact      summarize and shrink provider context
/status       show model and token usage
/model        choose the model for this topic
/effort       choose reasoning effort
/fork [name]  copy config and history into a new topic
/spawn [name] copy config into a fresh topic
/vault        open the encrypted-secret manager
/help         show all shortcuts
/quit         close the Terminal client
```

> Manage the vault with `/vault` in Terminal or `negotium vault --help`.

## Live subagent graph

Press `Ctrl-G` to open a live graph of the subagent tree. The graph shows which agent
owns each topic and how subagents or cross-topic requests connect them, laid out and
animated by [Orchgraph](https://github.com/maestrojeong/orchgraph).

- **Pan:** arrow keys or `h` / `j` / `k` / `l`
- **Change spacing:** `[` / `]`
- **Close:** `Esc` or `Ctrl-G`

![Live subagent tree, laid out by Orchgraph](https://raw.githubusercontent.com/maestrojeong/orchgraph/main/docs/images/negotium-subagents.svg)

## Decision graph

Press `Ctrl-D` from a conversation to render the current topic's recorded decisions and
their directed `causedBy` links with Orchgraph. Use arrow keys or `h` / `j` / `k` / `l`
to pan, `[` / `]` to change spacing, and `Esc` or `Ctrl-D` to close. Inside the topic
picker, `Ctrl-D` keeps its existing meaning: delete the selected topic.

## Colour

The Terminal picks a colour depth (`truecolor`, `ansi256`, `ansi16`, `none`) from
`COLORTERM`, `TERM`, and `TERM_PROGRAM`. Over ssh, `COLORTERM` is usually not
forwarded, so a remote host may fall back to 256 colours. Save the depth once
on that machine instead of exporting a variable every run:

```sh
echo truecolor > ~/.negotium/tui-color   # or ansi256 / ansi16 / none
```

Precedence, first match wins: `NEGOTIUM_TUI_COLOR` env, `NO_COLOR`,
`FORCE_COLOR`, then the saved file, then auto-detection. The saved file never
adds colour to a pipe or `TERM=dumb`, and it lives under `NEGOTIUM_STATE_DIR`
when that is set. macOS Terminal.app is capped at 256 colours unless you save
`truecolor` explicitly.
