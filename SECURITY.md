# Security policy

## Supported versions

Negotium is currently in the `0.x` series. Security fixes are made against the latest released
version only.

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include exploit details in discussions.

Open a public issue titled
[`Security contact request`](https://github.com/maestrojeong/negotium/issues/new?title=Security%20contact%20request)
with no vulnerability or exploit details. The maintainer will arrange a private reporting channel.
In the private report, include the affected package and version, impact, reproduction steps, and
any suggested mitigation. Remove API keys, bot tokens, vault contents, local state databases, and
other user data from the report.

The maintainer will acknowledge the report, investigate it, and coordinate disclosure and a fix.

## Security-sensitive areas

Reports involving the encrypted vault, node-control authentication, MCP process execution,
Telegram authorization, browser automation, file-path validation, or provider credentials are
especially important.
