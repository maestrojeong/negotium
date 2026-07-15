# Negotium documentation

Each document owns one part of the system. When a concept crosses boundaries, link to its owner
instead of copying the explanation.

| Document | Owns |
| --- | --- |
| [Architecture](./ARCHITECTURE.md) | Runtime concepts, invariants, state ownership, turn lifecycle, and recovery |
| [Adapters](./ADAPTERS.md) | Adapter lifecycle, channel mappings, topic access, and transcript projection |
| [Otium coupling](./OTIUM-COUPLING.md) | The versioned protocol between an Otium hub and a Negotium worker |
| [Feature review](./FEATURE-REVIEW.md) | Review order, acceptance questions, source areas, and regression coverage |
| [Releasing](./RELEASING.md) | Package validation and npm publication |

The root [README](../README.md) is the user-facing entry point. Package-specific setup belongs in
the package README beside the code it describes.

## Documentation rules

- Describe current Negotium behavior directly. Do not frame it through comparisons with another
  product or private repository.
- Keep architecture rationale in `ARCHITECTURE.md`; keep operational commands in the root or
  package README.
- Put Otium endpoint, authentication, idempotency, and event-order details only in
  `OTIUM-COUPLING.md`.
- Use `FEATURE-REVIEW.md` as a checklist, not as a second architecture document.
- Prefer repository-relative links and source paths that a contributor can open from this checkout.
- Mark incomplete behavior explicitly with an owner and an acceptance condition.
