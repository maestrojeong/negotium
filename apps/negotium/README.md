# negotium

The one-command installer for the Negotium multi-agent runtime and CLI. This is a functional,
unscoped entry package backed by [`@negotium/cli`](https://www.npmjs.com/package/@negotium/cli).

```bash
npm install --global negotium

negotium init
negotium terminal
negotium status
negotium stop
negotium telegram
negotium otium join <invite-code>
negotium start terminal
negotium start telegram  # separate shell
negotium start otium     # separate shell
```

Negotium requires Bun 1.2.15 or newer. See the
[main repository](https://github.com/maestrojeong/negotium) for configuration and architecture.
