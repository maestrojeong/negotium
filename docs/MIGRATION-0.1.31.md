# Migration to 0.1.31

Version 0.1.31 improves Terminal path references, background command completion delivery, and Wiki
memory filenames. No SQLite schema, stored topic, conversation, Vault, or browser-profile migration
is required.

## Terminal path references

- Typing `@` keeps the path trigger visible while composing, so returning to an existing path token
  can reopen search and continue completion.
- Search accepts basename substrings and finds sufficiently specific nested paths such as
  `ludo-agent`.
- On submit, Negotium removes `@` only when the referenced filesystem path exists. Mentions and
  unresolved paths remain unchanged.
- Completion and submission preserve surrounding punctuation.

## Background command delivery

- Background Bash now carries the canonical topic ID through the MCP transport and writes completion
  responses to the ID-addressed inbox.
- The inbox resolves that ID back to the current topic before injecting the completion. Delivery no
  longer depends on a mutable or ambiguous topic title.
- Existing in-flight commands started by an older process may still use the legacy route. Restart
  Negotium before relying on the new behavior.

## Wiki memory mirrors

- SQLite topic briefs remain keyed by the canonical topic ID.
- New human-readable mirror files use `Title--topic-id.md`; dated summaries use
  `YYYY-MM-DD-Title--topic-id.md`. The stable suffix prevents equal titles and slug collisions from
  overwriting each other.
- Runtime memory prompts prefer the new filename and fall back to existing ID-only or title-only
  files. Existing files do not need to be renamed manually.
- After a topic rename, the runtime can still locate mirrors by their stable ID suffix. A later
  archive writes the current title into the new mirror filename.

## Runtime maintenance

- Codex context usage and rollout migration now share the same whole-tree fallback lookup.
- Node control SSE endpoints share one polling, heartbeat, abort, and response-header implementation.
- The deprecated private `@negotium/adapter-testkit` workspace was removed. Adapter authors should
  continue importing test utilities from `@negotium/adapter-sdk/testkit`.

## Upgrade checklist

1. Upgrade `negotium` and `@negotium/adapter-sdk` together to `0.1.31`.
2. Restart Negotium, Terminal, and any long-running Background Bash processes.
3. Confirm a background command completion returns to the topic that launched it.
4. Confirm the next Wiki archive creates readable files with a stable topic ID suffix.
