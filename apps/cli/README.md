# @negotium/cli

Installable CLI for Negotium and its Terminal, Telegram, and Otium adapters.

```bash
npm install --global @negotium/cli

negotium init
negotium terminal
negotium telegram
negotium otium join <invite-code>
negotium start terminal telegram otium
```

For the shortest install command, `npm install --global negotium` provides this same CLI through
the functional unscoped entry package.

`negotium start` starts one `@negotium/node` and mounts all selected adapters in the same process.
See the repository's
[adapter guide](https://github.com/maestrojeong/Negotium/blob/main/docs/ADAPTERS.ko.md) for state
ownership and topic loading semantics.
