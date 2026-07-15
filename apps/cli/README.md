# @negotium/cli

Installable CLI for Negotium and its Terminal, Telegram, and Otium adapters.

Requires Bun 1.2.15 or newer on macOS or Linux, plus credentials for Claude, Codex, or Maestro.

```bash
npm install --global @negotium/cli

negotium init
negotium terminal
negotium status
negotium stop
negotium telegram
negotium otium join <invite-code>
negotium start terminal
negotium start telegram
negotium start otium
```

Run `claude` to authenticate Claude, `codex login` for Codex, or set `DEEPSEEK_API_KEY` for
Maestro. `negotium init` reports which providers are ready.

For the shortest install command, `npm install --global negotium` provides this same CLI through
the functional unscoped entry package.

`negotium terminal` is a short-lived client. It discovers or auto-starts one long-lived,
authenticated loopback node for the state directory, so an agent turn continues if the TUI exits
or crashes. Multiple Terminal clients may connect to it. Use `negotium serve` for a foreground
node, `negotium status`/`negotium stop` for lifecycle control, and
`negotium terminal --embedded` for the in-process fallback.

`negotium start` starts exactly one channel process. Telegram and Otium retain their independent
host lifecycle and singleton rules while they migrate to the same client boundary. All processes
share durable SQLite state.
See the repository's
[adapter guide](https://github.com/maestrojeong/negotium/blob/main/docs/ADAPTERS.md) for state
ownership and topic loading semantics.
