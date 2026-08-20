# Negotium documentation

Each document owns one part of the system. When a concept crosses boundaries, link to its owner
instead of copying the explanation.

| Document | Owns |
| --- | --- |
| [Architecture](./ARCHITECTURE.md) | Runtime concepts, invariants, state ownership, turn lifecycle, and recovery |
| [Adapters](./ADAPTERS.md) | Adapter lifecycle, channel mappings, topic access, and transcript projection |
| [Terminal usage](./TERMINAL-USAGE.md) | Keyboard shortcuts, chat commands, and the live subagent graph |
| [Otium coupling](./OTIUM-COUPLING.md) | The versioned protocol between an Otium hub and a Negotium worker |
| [Runtime Gateway contract](./RUNTIME-GATEWAY-CONTRACT.md) | Private loopback ingress from an Otium Hub/Gateway into its colocated Negotium runtime |
| [Otium enrollment and sharing](./OTIUM-ENROLLMENT-AND-SHARING.md) | Node invitation, enrollment security, topic-sharing product model, UX, and delivery plan |
| [Feature review](./FEATURE-REVIEW.md) | Review order, acceptance questions, source areas, and regression coverage |
| [Wiki search evaluation for 0.2.18](./WIKI-SEARCH-EVALUATION-0.2.18.md) | Topic, article, and summary retrieval dataset, metrics, and limitations |
| [Releasing](./RELEASING.md) | Package validation and npm publication |
| [Migration 0.4.0](./MIGRATION-0.4.0.md) | Codex Vault hooks and removal of credential execution MCP tools |
| [Migration 0.2.19](./MIGRATION-0.2.19.md) | The single wiki write tool, the summary catalog, and scan-free retrieval |
| [Migration 0.4.9](./MIGRATION-0.4.9.md) | Transport durability, strict workspace SSE isolation, and bounded queues |
| [Migration 0.5.0](./MIGRATION-0.5.0.md) | Chronological decision-graph spine and Browser.rs v0.1.23 |
| [Migration 0.5.3](./MIGRATION-0.5.3.md) | Streamable HTTP browser transport for Maestro agents |
| [Migration 0.5.4](./MIGRATION-0.5.4.md) | Public Browser.rs transport builder for embedding runtimes |
| [Migration 0.5.6](./MIGRATION-0.5.6.md) | Gateway-minted visual and file-delivery capabilities |
| [Migration 0.5.7](./MIGRATION-0.5.7.md) | Media visuals readable over the gateway read-back |
| [Migration 0.5.8](./MIGRATION-0.5.8.md) | Capability-gated tool notes in the shared prompt |
| [Migration 0.5.9](./MIGRATION-0.5.9.md) | show_video removed from the runtime tool surface |
| [Migration 0.2.0](./MIGRATION-0.2.0.md) | Historical single-user filesystem migration and completion marker |
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
| [Migration 0.1.43](./MIGRATION-0.1.43.md) | Ordered user-message preservation, subagent topology guidance, and canonical Wiki briefs |
| [Migration 0.1.44](./MIGRATION-0.1.44.md) | Title-scoped accumulated Wiki memory, immutable summaries, and concurrent archive safety |
| [Migration 0.1.45](./MIGRATION-0.1.45.md) | Explicit Wiki memory pipeline with scan-free retrieval |
| [Migration 0.1.46](./MIGRATION-0.1.46.md) | Terminal-adapter release: long-standing rendering fixes |
| [Migration 0.1.47](./MIGRATION-0.1.47.md) | Correctness release: one security fix and three operational fixes |
| [Migration 0.1.48](./MIGRATION-0.1.48.md) | Removes the mcp-patchright gateway; hosts browser MCP lifecycle directly |
| [Migration 0.1.49](./MIGRATION-0.1.49.md) | Fixes the public negotium/registry package contract |
| [Surface-scoped sessions](./SURFACE-SESSION-SEPARATION.md) | Per-surface session scoping and topic separation (S-1 through S-11) |
| [Otium node architecture](./OTIUM-NODE-ARCHITECTURE.md) | Otium workspace to Negotium node architecture and decisions |
| [Multi-workspace join](./MULTI-WORKSPACE-JOIN.md) | Joining several Otium workspaces without a restart (M-1 through M-9) |
| [Terminal deferred issues](./TERMINAL-DEFERRED.md) | Known terminal adapter issues deliberately left unfixed |
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
