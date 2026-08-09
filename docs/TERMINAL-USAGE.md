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
