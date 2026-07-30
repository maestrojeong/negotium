# Negotium documentation

Each document owns one part of the system. When a concept crosses boundaries, link to its owner
instead of copying the explanation.

| Document | Owns |
| --- | --- |
| [Architecture](./ARCHITECTURE.md) | Runtime concepts, invariants, state ownership, turn lifecycle, and recovery |
| [Adapters](./ADAPTERS.md) | Adapter lifecycle, channel mappings, topic access, and transcript projection |
| [Otium coupling](./OTIUM-COUPLING.md) | The versioned protocol between an Otium hub and a Negotium worker |
| [Runtime Gateway contract](./RUNTIME-GATEWAY-CONTRACT.md) | Private loopback ingress from an Otium Hub/Gateway into its colocated Negotium runtime |
| [Otium enrollment and sharing](./OTIUM-ENROLLMENT-AND-SHARING.md) | Node invitation, enrollment security, topic-sharing product model, UX, and delivery plan |
| [Feature review](./FEATURE-REVIEW.md) | Review order, acceptance questions, source areas, and regression coverage |
| [Releasing](./RELEASING.md) | Package validation and npm publication |
| [Migration 0.1.18](./MIGRATION-0.1.18.md) | Public helper adoption and Otium thin-adapter upgrade order |
| [Migration 0.1.19](./MIGRATION-0.1.19.md) | Reset memory safety and the next Otium deduplication boundary |
| [Migration 0.1.20](./MIGRATION-0.1.20.md) | Direct Vault placeholders and browser credential substitution |
| [Migration 0.1.21](./MIGRATION-0.1.21.md) | Compact model routing guidance and short-session memory policy |
| [Migration 0.1.22](./MIGRATION-0.1.22.md) | Direct browser credentials, automatic WebAuthn, and singleton daemon hardening |
| [Migration 0.1.23](./MIGRATION-0.1.23.md) | Default-deny Vault tool-input substitution and persistence boundary hardening |
| [Migration 0.1.24](./MIGRATION-0.1.24.md) | Browser output redaction ordering and fail-closed credential tracking |
| [Migration 0.1.25](./MIGRATION-0.1.25.md) | Kimi models, safe session reset, and unified model routing |
| [Migration 0.1.26](./MIGRATION-0.1.26.md) | Automatic Xvfb launch for headed browser automation on displayless Linux |
| [Migration 0.1.27](./MIGRATION-0.1.27.md) | Telegram file delivery, compact Terminal Vault commands, and stable final-row rendering |
| [Migration 0.1.28](./MIGRATION-0.1.28.md) | Terminal Vault list routing follow-up |
| [Migration 0.1.29](./MIGRATION-0.1.29.md) | Browser.rs, agent SDK isolation, provider Vault keys, and recursive path completion |
| [Migration 0.1.30](./MIGRATION-0.1.30.md) | Terminal tool timelines, reliable Codex diffs, Tasks sidebar, and code-block copy |
| [Migration 0.1.31](./MIGRATION-0.1.31.md) | Live path references, stable background delivery, and readable collision-safe Wiki mirrors |
| [Migration 0.1.32](./MIGRATION-0.1.32.md) | Topic-state isolation, reliable task panels, streaming lifecycle fixes, and ordered Telegram media |
| [Migration 0.1.33](./MIGRATION-0.1.33.md) | Durable user questions, compact terminal pastes, deletion shortcuts, and Maestro SDK 0.1.50 |
| [Migration 0.1.37](./MIGRATION-0.1.37.md) | Raw conversation preservation, active context projections, and fail-closed cleanup |
| [Migration 0.1.38](./MIGRATION-0.1.38.md) | Authenticated browser readiness, active-turn failure propagation, and startup orphan cleanup |
| [Migration 0.1.39](./MIGRATION-0.1.39.md) | Host-injected browser runtime and downstream fork reduction |
| [Migration 0.1.40](./MIGRATION-0.1.40.md) | Public durable ask-user storage, optional schedule_self prompt section, lazy storage-schema fix |
| [Migration 0.1.41](./MIGRATION-0.1.41.md) | Packaged runtime export fix for the default durable ask-user host |
| [Migration 0.1.42](./MIGRATION-0.1.42.md) | Browser gateway port ownership, spawn nonce readiness, and startup diagnostics |
| [Browser runtime](./BROWSER-RUNTIME.md) | Host-injected Playwright MCP lifecycle for downstream runtimes |
| [Otium runtime deduplication](./OTIUM-RUNTIME-DEDUP.md) | Public migration contracts and planned host-factory boundaries |

The root [README](../README.md) is the user-facing entry point. Package-specific setup belongs in
the package README beside the code it describes.

## Documentation rules

- Describe current Negotium behavior directly. Do not frame it through comparisons with another
  product or private repository.
- Keep architecture rationale in `ARCHITECTURE.md`; keep operational commands in the root or
  package README.
- Put remote hub/worker protocol details in `OTIUM-COUPLING.md`. Put the
  colocated private loopback ingress in `RUNTIME-GATEWAY-CONTRACT.md`; do not
  merge their credentials or trust boundaries.
- Put planned Otium enrollment, sharing UX, and rollout decisions in
  `OTIUM-ENROLLMENT-AND-SHARING.md` and label them as target behavior.
- Use `FEATURE-REVIEW.md` as a checklist, not as a second architecture document.
- Prefer repository-relative links and source paths that a contributor can open from this checkout.
- Mark incomplete behavior explicitly with an owner and an acceptance condition.
