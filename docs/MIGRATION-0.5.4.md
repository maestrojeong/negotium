# Migration 0.5.4 - public Browser.rs transport ownership

`0.5.4` exposes the authenticated Browser.rs transport builder from
`negotium/browser-runtime`. Embedding runtimes should call this helper instead of duplicating
agent-specific SSE and Streamable HTTP selection.

```ts
import { buildPlaywrightMcpTransport } from "negotium/browser-runtime";

const spec = buildPlaywrightMcpTransport(port, owner, capability, agent);
```

The helper preserves the existing contract: Claude uses authenticated SSE, Maestro uses
authenticated Streamable HTTP, and Codex receives its environment-backed HTTP header mapping.

The shared topic and channel prompt also notes that Computer Use comes from the optional `cua-rs`
MCP and that MCP configuration changes apply on the next session.

No data migration is required. Upgrade embedding runtimes to `negotium@0.5.4`, replace local
Playwright transport builders with the public helper, and restart the runtime process.
