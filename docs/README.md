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
