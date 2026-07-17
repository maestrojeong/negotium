# negotium

The one-command installer for the complete Negotium multi-agent node. The package includes the CLI,
runtime, MCP services, Cron module, and first-party Terminal, Telegram, and Otium adapters.

Requires Bun 1.2.15 or newer on macOS or Linux, plus credentials for Claude, Codex, or Maestro.

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

Authenticate Claude with `claude`, Codex with `codex login`, or Maestro with
`DEEPSEEK_API_KEY`. See the [main repository](https://github.com/maestrojeong/negotium) for
configuration, security guidance, and architecture.

## Hosted execution API

Embedding control planes can configure and invoke Negotium's provider execution layer without
importing package internals:

```ts
import {
  configureAgentExecutionHost,
  runHostedAgent,
  type AgentExecutionHost,
  type AgentQueryOptions,
  type UnifiedEvent,
} from "negotium/hosted-agent";

import {
  canonicalMcpBridgeEnv,
  registerCanonicalMcpBridgeEnvProvider,
  revokeCanonicalMcpBridgeTurn,
} from "negotium/canonical-mcp-bridge";
```

These subpaths are the stable public boundary. Paths under `negotium/dist/` are package internals
and may change between releases.
