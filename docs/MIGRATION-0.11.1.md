# Migration 0.11.1

Negotium 0.11.1 makes the Memory Archiver the single owner of deciding whether an archived session
belongs to an existing Persona or needs a new one.

## Persona routing

Before writing memory, the archiver searches and reads plausible topic briefs, then makes exactly one
decision:

- Reuse one canonical Persona when the brief confirms the same ongoing project, repository, role, or
  relationship, even if the room title is narrower.
- Create a new Persona when the context is genuinely separate or the available evidence is ambiguous.

One archive run never updates several Persona briefs. Existing Persona content is still rewritten as
the bounded mutable profile introduced in 0.11.0.

## Unchanged behavior

- No separate Persona curator, scheduler, or live-Topic organizer is added.
- Live Topic rooms and immutable session summaries are not merged or deleted.
- Wiki search, Persona size limits, Surface prompts, and adapter contracts are unchanged.
- No database migration is required.

## Upgrade notes

Run `bun install`, rebuild Negotium, and restart the resident Node so subsequent Memory Archiver runs
use the clarified routing policy.
