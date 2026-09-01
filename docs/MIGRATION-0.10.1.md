# Migration 0.10.1

Negotium 0.10.1 adds GLM model support through `maestro-agent-sdk` 0.5.0 and updates the managed
Browser.rs runtime to v0.2.1.

## GLM models

The Maestro backend now supports `glm-5.3`, `glm-5.2`, and `glm-5.3-flash`. Configure
`GLM_API_KEY` before selecting one of these models. `GLM_BASE_URL` can override the default Zhipu AI
endpoint for regional or proxy deployments.

All three models use extended reasoning and a roughly 1M-token context window. Only
`glm-5.3-flash` accepts images natively; the other GLM models degrade image inputs to text
placeholders.

## Browser.rs

The bundled installer now downloads Browser.rs v0.2.1 and verifies the release asset checksum.
Negotium also requires v0.2.1 for explicit Browser.rs binary overrides, so replace any older
`NEGOTIUM_BROWSER_RS_BIN` target before restarting.

## Upgrade notes

No database migration is required. Run `bun install`, rebuild Negotium, and restart the resident
Node so new sessions load the updated model catalog, SDK provider, and Browser.rs binary.
